// .env is copied from .env.example, which carries `OMG_REPOS_ROOT=` as a
// documentation placeholder. seed_env guarded on the key being *present*, so
// that empty line counted as "already configured" and the seed was skipped —
// leaving every fresh install with no repos root at all.
//
// It is not a cosmetic default. The folder picker asks the server for its
// default directory, gets 400 "folder does not exist", and the drawer strands
// on "Opening…" with an empty listing and nowhere to navigate from. The picker
// has a fallback to the repos root for exactly this situation; an empty root
// means the fallback lands on the same 400.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFunctionSource } from "./setup-script-helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Run seed_env against a throwaway .env and return the resulting contents. */
function seed(envContents: string, calls: [string, string][]): string {
  const dir = mkdtempSync(join(tmpdir(), "omg-seed-"));
  roots.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), envContents);
  const script = [
    "set -euo pipefail",
    `LFG_DIR=${JSON.stringify(dir)}`,
    extractFunctionSource("seed_env"),
    ...calls.map(([k, v]) => `seed_env ${JSON.stringify(k)} ${JSON.stringify(v)}`),
  ].join("\n");
  const result = Bun.spawnSync(["bash", "-c", script]);
  expect(new TextDecoder().decode(result.stderr)).toBe("");
  return readFileSync(join(dir, ".env"), "utf8");
}

describe("seeding .env defaults", () => {
  // The regression itself.
  test("an empty placeholder is filled, not treated as configured", () => {
    const out = seed("OMG_REPOS_ROOT=\n", [["REPOS_ROOT", "/home/u/repos"]]);
    expect(out).toContain("OMG_REPOS_ROOT=/home/u/repos");
  });

  test("filling a placeholder does not leave two assignments behind", () => {
    const out = seed("OMG_REPOS_ROOT=\n", [["REPOS_ROOT", "/home/u/repos"]]);
    const assignments = out.split("\n").filter(l => /^(OMG_|LFG_)REPOS_ROOT=/.test(l));
    expect(assignments).toEqual(["OMG_REPOS_ROOT=/home/u/repos"]);
  });

  test("a real value is never overwritten", () => {
    const out = seed("OMG_REPOS_ROOT=/my/code\n", [["REPOS_ROOT", "/home/u/repos"]]);
    expect(out).toContain("OMG_REPOS_ROOT=/my/code");
    expect(out).not.toContain("/home/u/repos");
  });

  // Appending an OMG_ twin would silently out-rank the legacy value, since
  // OMG_ wins in src/env-compat.ts.
  test("a legacy LFG_ value is respected rather than shadowed", () => {
    const out = seed("LFG_REPOS_ROOT=/legacy/code\n", [["REPOS_ROOT", "/home/u/repos"]]);
    expect(out).toContain("LFG_REPOS_ROOT=/legacy/code");
    expect(out).not.toContain("OMG_REPOS_ROOT=");
  });

  test("an empty legacy placeholder is filled with the OMG_ spelling", () => {
    const out = seed("LFG_REPOS_ROOT=\n", [["REPOS_ROOT", "/home/u/repos"]]);
    expect(out).toContain("OMG_REPOS_ROOT=/home/u/repos");
    expect(out.split("\n").filter(l => /REPOS_ROOT=/.test(l))).toHaveLength(1);
  });

  test("a missing key is appended", () => {
    const out = seed("OTHER=1\n", [["REPOS_ROOT", "/home/u/repos"]]);
    expect(out).toContain("OTHER=1");
    expect(out).toContain("OMG_REPOS_ROOT=/home/u/repos");
  });

  test("surrounding lines and comments survive", () => {
    const out = seed("# comment\nOMG_HOST=127.0.0.1\nOMG_REPOS_ROOT=\nOMG_PORT=8766\n", [
      ["REPOS_ROOT", "/home/u/repos"],
    ]);
    expect(out.split("\n")).toEqual([
      "# comment",
      "OMG_HOST=127.0.0.1",
      "OMG_REPOS_ROOT=/home/u/repos",
      "OMG_PORT=8766",
      "",
    ]);
  });

  test("re-running setup is idempotent", () => {
    const once = seed("OMG_REPOS_ROOT=\n", [["REPOS_ROOT", "/home/u/repos"]]);
    const twice = seed(once, [["REPOS_ROOT", "/home/u/repos"]]);
    expect(twice).toBe(once);
  });

  test("whitespace-only counts as empty", () => {
    const out = seed("OMG_REPOS_ROOT=   \n", [["REPOS_ROOT", "/home/u/repos"]]);
    expect(out).toContain("OMG_REPOS_ROOT=/home/u/repos");
  });
});

describe("the shipped .env.example", () => {
  // Guards the other half: if the example ever gains an empty placeholder for a
  // key setup seeds, the fill path above must be the thing that covers it.
  test("every key setup seeds is either unset or non-empty after seeding", () => {
    const example = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
    const seeded = ["HOST", "PORT", "REPOS_ROOT"];
    const out = seed(example, seeded.map(k => [k, `/seeded/${k}`] as [string, string]));
    for (const key of seeded) {
      const line = out.split("\n").find(l => new RegExp(`^(OMG_|LFG_)${key}=`).test(l));
      expect(line, `${key} missing from .env after seeding`).toBeDefined();
      expect(line!.split("=").slice(1).join("=").trim(), `${key} left empty`).not.toBe("");
    }
  });
});
