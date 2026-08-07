import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as read } from "node:fs";
import { extractFunctionSource, SETUP_SH } from "./setup-script-helpers.ts";

describe("setup.sh .env seeding during the OMG_ migration", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seed(existingEnv: string, calls: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "lfg-setup-env-"));
    roots.push(root);
    const envPath = join(root, ".env");
    writeFileSync(envPath, existingEnv);
    const script = [
      "set -euo pipefail",
      `LFG_DIR="$1"`,
      extractFunctionSource("seed_env"),
      ...calls,
    ].join("\n");
    const result = Bun.spawnSync(["bash", "-c", script, "bash", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return readFileSync(envPath, "utf8");
  }

  test("a fresh .env is seeded with the new OMG_ prefix", () => {
    const out = seed("", ['seed_env HOST 127.0.0.1', 'seed_env PORT 8766']);
    expect(out).toContain("OMG_HOST=127.0.0.1");
    expect(out).toContain("OMG_PORT=8766");
    expect(out).not.toContain("LFG_HOST=");
  });

  // The regression this guards: appending an OMG_ twin next to a customised
  // LFG_ value would silently win (OMG_ out-ranks LFG_ in src/env-compat.ts)
  // and revert an existing install's configuration to the default.
  test("an existing install's customised LFG_ value is not overridden by a twin", () => {
    const out = seed("LFG_PORT=9999\nLFG_HOST=127.0.0.1\n", [
      'seed_env HOST 127.0.0.1',
      'seed_env PORT 8766',
    ]);
    expect(out).not.toContain("OMG_PORT=");
    expect(out).not.toContain("OMG_HOST=");
    expect(out).toContain("LFG_PORT=9999");
  });

  test("an already-migrated OMG_ value is not duplicated", () => {
    const out = seed("OMG_PORT=9999\n", ['seed_env PORT 8766']);
    expect(out.match(/OMG_PORT=/g)).toHaveLength(1);
    expect(out).toContain("OMG_PORT=9999");
  });

  test("only the missing keys are appended", () => {
    const out = seed("LFG_PORT=9999\n", ['seed_env HOST 127.0.0.1', 'seed_env PORT 8766']);
    expect(out).toContain("LFG_PORT=9999");
    expect(out).toContain("OMG_HOST=127.0.0.1");
    expect(out).not.toContain("OMG_PORT=");
  });

  // The service units hard-bind the UI to loopback. env-compat lets OMG_HOST
  // out-rank LFG_HOST, so pinning only the legacy spelling would let an
  // OMG_HOST=0.0.0.0 in .env expose the unauthenticated UI to the network.
  test("both host spellings are pinned in the service definitions", () => {
    const setup = read(SETUP_SH, "utf8");
    expect(setup).toContain("Environment=LFG_HOST=127.0.0.1");
    expect(setup).toContain("Environment=OMG_HOST=127.0.0.1");
    expect(setup).toContain("LFG_HOST=127.0.0.1 OMG_HOST=127.0.0.1");
  });
});
