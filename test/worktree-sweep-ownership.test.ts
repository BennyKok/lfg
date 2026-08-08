// WORKTREE_ROOT is a shared directory on a developer's machine, not private
// scratch space owned by the sweeper. People park hand-made worktrees, release
// checkouts and full clones in there. Those have no tmux session, no managed
// registry row and usually no process sitting in them, which is exactly the
// shape the sweeper called "stale" — so it deleted them, repeatedly.
//
// Observed 2026-08-08 in the serve log: `vibes-frontdoor` and `vibes-lfgpin`,
// both hand-made worktrees of ~/repos/vibes, removed 22 minutes apart. The
// owner's workaround was to move their worktrees out of the directory entirely.
//
// Two rules are locked in here:
//   1. The sweeper may only delete worktrees the sweeper itself provisioned.
//   2. Even then, never delete one holding uncommitted work.
//
// Like the live-process probe next door, this runs the sweeper in a subprocess
// pinned to a throwaway LFG_WORKTREE_ROOT — importing it in-process would sweep
// the developer's REAL worktrees as a side effect.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");

type SweepResult = {
  scanned: number;
  removed: string[];
  kept: number;
  skippedYoung: number;
  failed: string[];
  unmanaged: string[];
  dirty: string[];
};

type Probe = {
  sweep: SweepResult;
  stillExists: Record<string, boolean>;
};

function runProbe(): Probe {
  const root = mkdtempSync(join(tmpdir(), "lfg-sweep-own-"));
  const scriptPath = join(root, "probe.mjs");
  const worktreeRoot = join(root, "worktrees");
  writeFileSync(
    scriptPath,
    `
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const root = process.env.LFG_WORKTREE_ROOT;
mkdirSync(root, { recursive: true });

const run = (cwd, ...args) =>
  Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });

// An upstream repo with one commit, so real worktrees can be added from it.
const origin = process.env.PROBE_ORIGIN;
mkdirSync(origin, { recursive: true });
run(origin, "init", "-q", "-b", "main");
run(origin, "config", "user.email", "probe@example.com");
run(origin, "config", "user.name", "probe");
writeFileSync(origin + "/README.md", "hi\\n");
run(origin, "add", "-A");
run(origin, "commit", "-qm", "init");

// 1. A hand-made worktree a human parked here. No ownership marker.
const handmade = root + "/handmade-release";
run(origin, "worktree", "add", "-q", "-b", "handmade", handmade, "main");

// 2. A worktree the sweeper provisioned, clean. Reclaimable.
const clean = root + "/lfg-clean";
run(origin, "worktree", "add", "-q", "-b", "session_clean", clean, "main");

// 3. A worktree the sweeper provisioned holding uncommitted work.
const dirty = root + "/lfg-dirty";
run(origin, "worktree", "add", "-q", "-b", "session_dirty", dirty, "main");
writeFileSync(dirty + "/unsaved-work.txt", "hours of it\\n");

// Mark only the two the sweeper "created".
mkdirSync(root + "/.lfg-owned", { recursive: true });
writeFileSync(root + "/.lfg-owned/lfg-clean", "0\\n");
writeFileSync(root + "/.lfg-owned/lfg-dirty", "0\\n");

const { sweepStaleWorktrees } = await import(${JSON.stringify(join(REPO, "src/worktree.ts"))});
const sweep = await sweepStaleWorktrees({ minAgeMs: 0 });

console.log(JSON.stringify({
  sweep,
  stillExists: {
    "handmade-release": existsSync(handmade),
    "lfg-clean": existsSync(clean),
    "lfg-dirty": existsSync(dirty),
    "dirty-file": existsSync(dirty + "/unsaved-work.txt"),
  },
}));
`,
  );
  try {
    const r = Bun.spawnSync(["bun", scriptPath], {
      env: {
        ...process.env,
        LFG_WORKTREE_ROOT: worktreeRoot,
        PROBE_ORIGIN: join(root, "origin"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString().trim();
    expect(r.exitCode, `probe failed: ${r.stderr.toString()}`).toBe(0);
    const line = out.split("\n").at(-1) ?? "";
    expect(line, `probe stdout: ${out}\nstderr: ${r.stderr.toString()}`).toStartWith("{");
    return JSON.parse(line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("worktree sweep ownership", () => {
  const probe = runProbe();

  test("never touches a worktree it did not provision", () => {
    const { sweep, stillExists } = probe;
    expect(sweep.removed).not.toContain("handmade-release");
    // `failed` counts too: it means the sweeper tried and git refused.
    expect(sweep.failed).not.toContain("handmade-release");
    expect(sweep.unmanaged).toContain("handmade-release");
    expect(stillExists["handmade-release"]).toBe(true);
  });

  test("keeps an owned worktree that holds uncommitted work", () => {
    const { sweep, stillExists } = probe;
    expect(sweep.removed).not.toContain("lfg-dirty");
    expect(sweep.dirty).toContain("lfg-dirty");
    expect(stillExists["lfg-dirty"]).toBe(true);
    expect(stillExists["dirty-file"]).toBe(true);
  });

  test("still reclaims an owned worktree with nothing left to lose", () => {
    const { sweep, stillExists } = probe;
    // Proves the two keeps above come from the new guards rather than the
    // sweeper having stopped removing anything at all.
    expect(sweep.removed).toContain("lfg-clean");
    expect(stillExists["lfg-clean"]).toBe(false);
  });
});
