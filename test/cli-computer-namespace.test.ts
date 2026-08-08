// `omg` may be this CLI or the omg.dev CLI, depending on which comes first on
// PATH — a real situation, not a hypothetical: on a Mac with both installed,
// `omg setup` reaches the omg.dev CLI, which has no `setup`, and prints its
// help instead of doing anything.
//
// So one spelling has to work with either binary. `omg computer <verb>` is that
// spelling: the omg.dev CLI routes it here, and this CLI accepts it directly
// for machines where the omg.dev CLI was never installed.
import { describe, expect, test } from "bun:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function run(args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, LFG_INSTALL_CHANNEL: "container" },
  });
  return {
    code: result.exitCode,
    out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
  };
}

describe("omg computer <verb>", () => {
  test("routes to the same command as the bare verb", () => {
    // `container` makes update refuse in a stable, side-effect-free way, so the
    // two spellings can be compared without touching the machine.
    const bare = run(["update"]);
    const namespaced = run(["computer", "update"]);
    expect(namespaced.out).toBe(bare.out);
    expect(namespaced.code).toBe(bare.code);
  });

  test("forwards flags through the namespace", () => {
    expect(run(["computer", "update", "--help"]).out).toContain("Usage: omg update");
  });

  test("uninstall is reachable both ways", () => {
    expect(run(["computer", "uninstall", "--help"]).out).toContain("Usage:");
  });

  // The omg.dev CLI calls this `computer status`; this CLI has no such command,
  // so it maps to the read-only update check rather than inventing a second
  // status surface that could disagree with it.
  test("computer status reports without changing anything", () => {
    const out = run(["computer", "status"]).out;
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("Unknown command");
  });

  // A verb this CLI does not have must not be silently swallowed by the
  // namespace — the error should name what was actually typed.
  test("an unknown verb still errors", () => {
    const out = run(["computer", "definitely-not-a-verb"]).out;
    expect(out).toContain("Unknown command");
  });

  test("bare `computer` does not pretend to be a command", () => {
    expect(run(["computer"]).out).toContain("Unknown command");
  });

  test("the bare verbs the service unit and MCP configs use still work", () => {
    // These are invoked as `src/cli.ts <verb>` by the systemd/launchd unit and
    // by every already-registered MCP config. Breaking them would mean
    // migrating third-party agent configs.
    expect(run(["update", "--help"]).out).toContain("Usage: omg update");
    expect(run(["uninstall", "--help"]).out).toContain("Usage:");
  });
});

describe("the machine-readable pairing contract", () => {
  // The omg.dev CLI used to learn the relay URL by regex-matching this
  // command's prose, across repositories. Rewording a log line — exactly what
  // the LFG→omg.dev branding sweep did — would have broken pairing silently.
  test("connect status --json is parseable and complete", () => {
    const { out } = run(["connect", "status", "--json"]);
    const line = out.trim().split("\n").at(-1)!;
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed).sort()).toEqual(
      ["boxId", "computerUrl", "pairedAt", "paired", "relayUrl"].sort(),
    );
    expect(typeof parsed.paired).toBe("boolean");
  });

  test("an unpaired box reports paired:false with nulls, not an error", () => {
    const { code, out } = run(["connect", "status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.trim().split("\n").at(-1)!);
    if (!parsed.paired) {
      expect(parsed.relayUrl).toBeNull();
      expect(parsed.boxId).toBeNull();
    }
  });

  test("the human output stays human", () => {
    const { out } = run(["connect", "status"]);
    expect(out).not.toContain("{");
    expect(out).toContain("omg connect:");
  });
});
