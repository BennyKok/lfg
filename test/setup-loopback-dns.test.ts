// Preferring a DNS name that already points at loopback is what removes the
// sudo prompt: no /etc/hosts write, nothing for uninstall to undo, and it
// behaves the same on macOS and Linux.
//
// The safety property under test is narrow and important: only trust a name
// when EVERY address it resolves to is loopback. A name that resolves anywhere
// else — a stale record, a wildcard, a hijacking resolver — would point the UI
// at a machine that is not this one.
import { describe, expect, test } from "bun:test";
import { extractFunctionSource } from "./setup-script-helpers.ts";

/** Run resolves_to_loopback() with `dig` stubbed to return given addresses. */
function resolves(addresses: string[]): boolean {
  const script = [
    "set -uo pipefail",
    // Stub dig as a shell function: `command -v dig` finds functions, so the
    // real binary is never consulted and no `command` override is needed.
    //
    // One argument per address with `printf '%s\\n'`, rather than one embedded
    // string: `printf '%s'` does not interpret escapes, so a JSON-quoted
    // "a\nb" would reach the filter as the literal characters a \ n b.
    addresses.length === 0
      ? "dig() { :; }"
      : `dig() { printf '%s\\n' ${addresses.map(a => `'${a}'`).join(" ")}; }`,
    extractFunctionSource("resolves_to_loopback"),
    'resolves_to_loopback example.test && echo YES || echo NO',
  ].join("\n");
  const result = Bun.spawnSync(["bash", "-c", script]);
  return new TextDecoder().decode(result.stdout).trim().endsWith("YES");
}

describe("loopback DNS detection", () => {
  test("a name resolving only to loopback is used", () => {
    expect(resolves(["127.0.0.1"])).toBe(true);
    expect(resolves(["127.0.0.1", "127.0.0.2"])).toBe(true);
  });

  test("a name resolving anywhere else is refused", () => {
    expect(resolves(["93.184.216.34"])).toBe(false);
    expect(resolves(["10.0.0.5"])).toBe(false);
    // Cloudflare, which is what local.drizzle.studio actually resolves to —
    // a hosted UI, not a loopback name.
    expect(resolves(["172.64.80.1"])).toBe(false);
  });

  // The dangerous case: partly loopback. Browsers may pick either address, so
  // anything less than unanimous is not safe to advertise.
  test("a mixed answer is refused, not accepted on the loopback entry", () => {
    expect(resolves(["127.0.0.1", "93.184.216.34"])).toBe(false);
    expect(resolves(["93.184.216.34", "127.0.0.1"])).toBe(false);
  });

  test("no answer at all falls back rather than claiming success", () => {
    expect(resolves([])).toBe(false);
  });
});
