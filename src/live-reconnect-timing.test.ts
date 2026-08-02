// Reconnect latency is dominated by two client-side constants, not by the
// server: measured against the live server, upgrade is ~1ms and the first frame
// after subscribe is 3-9ms, while a returning tab could sit for 2s on a probe
// timeout and a woken laptop could sit at the 10s backoff cap.
//
// These pin the two numbers that produce that wait, because both are easy to
// regress by "just" raising a timeout again.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync("web/src/useLiveSocket.ts", "utf8");

function constant(name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+)`));
  if (!match) throw new Error(`${name} not found in useLiveSocket.ts`);
  return Number(match[1].replace(/_/g, ""));
}

describe("live socket reconnect timing", () => {
  test("a returning tab gives a stale socket well under a second to answer", () => {
    // The server answers a live socket in single-digit milliseconds, so a
    // socket that has not replied in half a second is dead rather than slow.
    // This was 2000ms, which was the whole of the "reconnect feels slow" delay
    // on every foreground return after a laptop wake.
    expect(constant("VISIBILITY_PROBE_TIMEOUT_MS")).toBeLessThanOrEqual(600);
  });

  test("waking the tab or regaining the network restarts the retry schedule", () => {
    // Without this the first post-wake attempt (which usually fails, because
    // Wi-Fi has not re-associated yet) is followed by a wait at the backoff
    // cap — up to 12.5s of dead time with "offline" showing over a working
    // network.
    expect(source).toContain("const resetBackoff = ()");
    const resetCalls = source.match(/resetBackoff\(\);/g) ?? [];
    expect(resetCalls.length).toBeGreaterThanOrEqual(2);

    const onVisible = source.slice(source.indexOf("const onVisible = ()"));
    expect(onVisible.slice(0, onVisible.indexOf("const onOnline"))).toContain("resetBackoff();");
    const onOnline = source.slice(source.indexOf("const onOnline = ()"));
    expect(onOnline.slice(0, 400)).toContain("resetBackoff();");
  });

  test("the reset clears both the delay and the attempt counter", () => {
    // The counter drives the "offline" banner: resetting only the delay would
    // leave the alarming state up while reconnecting quickly underneath it.
    const helper = source.slice(source.indexOf("const resetBackoff = ()"));
    const body = helper.slice(0, helper.indexOf("};") + 2);
    expect(body).toContain("backoffRef.current = BACKOFF_MIN_MS");
    expect(body).toContain("reconnectsRef.current = 0");
  });
});
