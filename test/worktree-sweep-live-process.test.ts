// The worktree sweeper decides "is this session still alive?" from tmux and the
// managed registry. Both are proxies, and both lie for harness backends
// (aisdk / codex-aisdk / opencode): they run as bare processes with no tmux
// session, so `tmuxHasSession` is always false and the registry becomes a
// single point of failure. When serve restarted and session-recovery didn't
// re-adopt one, the sweeper deleted the worktree of a still-running agent —
// uncommitted work included. (Observed 2026-08-06: lfg-619705 and lfg-8b32e1
// were both removed while their processes were still running in them.)
//
// The guard is /proc/<pid>/cwd: ground truth, and additive-only — it can keep a
// worktree but never remove one.
//
// This runs the sweeper in a subprocess pinned to a throwaway LFG_WORKTREE_ROOT.
// Importing it here would sweep the developer's REAL worktrees as a side effect.
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
};

function runProbe(): { name: string; withLive: SweepResult; afterExit: SweepResult } {
  const root = mkdtempSync(join(tmpdir(), "lfg-sweep-probe-"));
  const scriptPath = join(root, "probe.mjs");
  // The probe lives outside the sweep root so its own file never counts as a
  // worktree, and the sweeper only ever sees the one directory we create.
  const worktreeRoot = join(root, "worktrees");
  writeFileSync(
    scriptPath,
    `
import { mkdirSync } from "node:fs";
const root = process.env.LFG_WORKTREE_ROOT;
const name = "lfg-sweepprobe";
const dir = root + "/" + name;
mkdirSync(dir, { recursive: true });

const { sweepStaleWorktrees } = await import(${JSON.stringify(join(REPO, "src/worktree.ts"))});

// A live process sitting in the worktree, with no tmux session and no managed
// registry entry — exactly the harness-backend shape that used to get reaped.
const proc = Bun.spawn(["sleep", "30"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
await Bun.sleep(400);
const withLive = await sweepStaleWorktrees({ minAgeMs: 0 });

proc.kill();
await proc.exited;
await Bun.sleep(400);
const afterExit = await sweepStaleWorktrees({ minAgeMs: 0 });

console.log(JSON.stringify({ name, withLive, afterExit }));
`,
  );
  try {
    const r = Bun.spawnSync(["bun", scriptPath], {
      env: { ...process.env, LFG_WORKTREE_ROOT: worktreeRoot },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString().trim();
    expect(r.exitCode, `probe failed: ${r.stderr.toString()}`).toBe(0);
    // The probe prints its JSON as the final line; anything before it is noise
    // from the imported module (fetch logs, warnings).
    const line = out.split("\n").at(-1) ?? "";
    expect(line, `probe stdout: ${out}\nstderr: ${r.stderr.toString()}`).toStartWith("{");
    return JSON.parse(line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("worktree sweep vs. a live process", () => {
  const probe = runProbe();

  test("keeps a worktree a running process is still working in", () => {
    const { name, withLive } = probe;
    expect(withLive.removed).not.toContain(name);
    // `failed` means it tried and git refused — also a reap attempt.
    expect(withLive.failed).not.toContain(name);
    expect(withLive.kept).toBeGreaterThan(0);
  });

  test("still reaps it once nothing is running there", () => {
    const { name, afterExit } = probe;
    // Proves the keep above came from the liveness guard and not from the
    // directory being unsweepable for some unrelated reason.
    expect([...afterExit.removed, ...afterExit.failed]).toContain(name);
    expect(afterExit.kept).toBe(0);
  });
});
