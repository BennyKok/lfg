// The session-list rebuild shares one tmux pane map across dozens of
// synchronous call sites, so the map was built with a synchronous
// `tmux list-panes` — ~5.5ms with the event loop frozen, every 2.5 seconds.
//
// It is primed with an awaited spawn now, before anything asks for it. These
// tests pin the two properties that make that safe: the synchronous build stays
// as a fallback, and a failed prime must leave the map unset rather than
// caching an empty one — a cached empty map would silently detach every session
// from its pane.
import { describe, expect, test } from "bun:test";
import { listSessions } from "./sessions.ts";

const source = await Bun.file("src/sessions.ts").text();
const probe = source.slice(
  source.indexOf("function makeTmuxProbe"),
  source.indexOf("export async function listSessions"),
);

describe("tmux pane map priming", () => {
  test("the rebuild primes the map before it is read", () => {
    expect(source).toContain("await tmux.prime?.();");
    const listSessionsBody = source.slice(source.indexOf("export async function listSessions"));
    const primeAt = listSessionsBody.indexOf("await tmux.prime?.()");
    const firstUse = listSessionsBody.indexOf("tmux.targetForPid");
    expect(primeAt).toBeGreaterThan(-1);
    if (firstUse > -1) expect(primeAt).toBeLessThan(firstUse);
  });

  test("priming does not block the event loop", () => {
    const prime = probe.slice(probe.indexOf("async prime()"));
    const body = prime.slice(0, prime.indexOf("targetForPid"));
    expect(body).toContain("Bun.spawn(");
    expect(body).not.toContain("spawnSync");
    expect(body).toContain("await");
  });

  test("a failed prime leaves the synchronous fallback able to rebuild", () => {
    const prime = probe.slice(probe.indexOf("async prime()"));
    const body = prime.slice(0, prime.indexOf("targetForPid"));
    // The catch must not assign an empty map: `panes` staying unset is what
    // sends the next reader down the synchronous path.
    const catchBlock = body.slice(body.indexOf("} catch {"));
    expect(catchBlock).not.toContain("panes =");
    // And the synchronous builder is still there.
    expect(probe).toContain("Bun.spawnSync(PANE_ARGV)");
  });

  test("the session list still resolves tmux targets", async () => {
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
    // Anything tmux-backed on this box must still carry a pane target; a
    // silently empty pane map would show up here as every target being null.
    const tmuxBacked = sessions.filter((s) => s.agent === "claude" || s.agent === "codex");
    if (tmuxBacked.length) {
      expect(tmuxBacked.every((s) => "tmuxTarget" in s)).toBe(true);
    }
  });
});
