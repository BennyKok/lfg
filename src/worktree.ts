// Auto-provision an isolated git worktree per lfg-managed session so agents
// never collide on a shared checkout (see docs/repo-hygiene.md). Voice-only
// orchestrator sessions are the lone automatic exception.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { MAIN_REF } from "./agents/collectors/git-fresh.ts";
import { listManaged } from "./managed.ts";
import { tmuxHasSession } from "./tmux.ts";

// Persistent, env-overridable. Never default to /tmp: it is cleared on reboot
// (systemd-tmpfiles), which silently destroys every live session's worktree —
// including uncommitted work. Keep this in sync with the same default in
// projects.ts (a shared import would create a projects→worktree→tmux cycle).
export const WORKTREE_ROOT = resolve(
  process.env.LFG_WORKTREE_ROOT ?? `${homedir()}/lfg-worktrees`,
);

export type SessionWorktree = {
  repoRoot: string;
  branch: string;
  path: string;
};

/**
 * Every git call here is awaited rather than spawnSync'd.
 *
 * Provisioning a worktree is 4-6 git processes, and `git worktree add` alone
 * copies a working tree to disk. Run synchronously they freeze Bun's single
 * event loop for the whole sequence, so one person clicking "new session"
 * stalls every other session's live stream. Awaiting yields between calls: the
 * create still takes what it takes, but nothing else in the server waits on it.
 */
async function git(
  repo: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn({
    cmd: ["git", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = opts?.timeoutMs ? setTimeout(() => proc.kill(), opts.timeoutMs) : null;
  try {
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, out, err };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return (await git(resolve(path), ["rev-parse", "--git-dir"])).ok;
}

async function hasHeadCommit(path: string): Promise<boolean> {
  return (await git(resolve(path), ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}

export function sessionWorktreeEnabled(): boolean {
  return process.env.LFG_SESSION_WORKTREE !== "0";
}

export async function shouldAutoWorktree(
  repoRoot: string,
  opts?: { worktree?: boolean; selfRepo?: string },
): Promise<boolean> {
  const abs = resolve(repoRoot);
  const isSelfRepo = !!opts?.selfRepo && resolve(opts.selfRepo) === abs;
  // Shared-checkout opt-out remains available for ordinary projects, but not
  // for LFG itself: allowing one API caller to set worktree=false would reopen
  // the exact multi-session data-loss path this isolation is meant to close.
  if (opts?.worktree === false && !isSelfRepo) return false;
  // Explicit `worktree: true` is a hard opt-in: it overrides the default-off
  // guards (global disable) so an agent asked to
  // isolate ALWAYS lands in /tmp/lfg-wt instead of editing a shared checkout in
  // place. This is what lets an lfg subagent safely rewrite serve.ts/App.tsx
  // without colliding with the ~15 sessions live in the shared tree.
  if (opts?.worktree === true) return await isGitRepo(abs);
  // Otherwise fall back to the auto policy: on by default, including LFG's own
  // repository. The old self-repo exception let concurrent LFG sessions edit
  // and deploy the same checkout, so the last finisher silently erased earlier
  // work. `selfRepo` now strengthens rather than weakens the isolation policy.
  if (!sessionWorktreeEnabled()) return false;
  // "Use this folder" can initialize an existing directory as an unborn Git
  // repository. There is no commit from which Git can create a worktree yet,
  // but the first coding agent still needs to launch so it can inspect the
  // existing files and make that commit. Run that first session in place;
  // subsequent sessions regain normal worktree isolation once HEAD exists.
  return (await isGitRepo(abs)) && (await hasHeadCommit(abs));
}

// Refreshing origin/main before branching is a NETWORK round trip. It used to
// run synchronously on the session-create path, where it cost ~208ms on a good
// link, unbounded on a bad one, and froze Bun's single event loop for the whole
// round trip.
//
// It is now off the create path entirely: the refresh is started in the
// background and never awaited, so a create branches from the main already on
// disk and the fetch it kicks off benefits the *next* one.
//
// That is safe for the same reason skipping was: worktreeBaseRef below picks
// whichever main ref exists and prefers a local main that is ahead, so the
// worst case is a base up to a TTL old — one rebase away, and exactly what a
// create a minute earlier would have produced anyway. The TTL still collapses a
// burst of creates (or a fork, which creates through its own internal request)
// into one fetch, and the timeout still stops an unreachable remote from
// leaving a git process wedged behind us.
const FETCH_MAIN_TTL_MS = 60_000;
const FETCH_MAIN_TIMEOUT_MS = 10_000;
const lastMainFetchAt = new Map<string, number>();

function refreshMainInBackground(repo: string): void {
  const now = Date.now();
  const last = lastMainFetchAt.get(repo);
  if (last !== undefined && now - last < FETCH_MAIN_TTL_MS) return;
  // Recorded BEFORE the call, so a remote that times out is retried on the same
  // TTL as one that succeeds. Otherwise every create during an outage would pay
  // the full timeout again.
  lastMainFetchAt.set(repo, now);
  void git(repo, ["fetch", "--quiet", "origin", "main"], {
    timeoutMs: FETCH_MAIN_TIMEOUT_MS,
  }).catch(() => {});
}

async function worktreeBaseRef(
  repo: string,
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  // Independent lookups, so they run concurrently rather than one after the
  // other — two git boots in the time of one.
  const [remoteMain, localMain] = await Promise.all([
    git(repo, ["rev-parse", "--verify", "--quiet", MAIN_REF]),
    git(repo, ["rev-parse", "--verify", "--quiet", "main"]),
  ]);

  if (localMain.ok) {
    if (!remoteMain.ok) return { ok: true, ref: "main" };
    const ahead = await git(repo, ["rev-list", "--count", `${MAIN_REF}..main`]);
    if (ahead.ok && parseInt(ahead.out.trim(), 10) > 0) return { ok: true, ref: "main" };
    return { ok: true, ref: MAIN_REF };
  }
  if (remoteMain.ok) return { ok: true, ref: MAIN_REF };

  // Imported local repositories may use another default branch. A real HEAD is
  // sufficient; an unborn repository is not, because Git cannot make a
  // worktree without a commit to branch from.
  const head = await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.ok) return { ok: true, ref: "HEAD" };
  return { ok: false, error: "repository has no commits; create an initial commit first" };
}

// Create (or reuse) a per-session worktree from the newest usable main ref.
export async function prepareSessionWorktree(
  repoRoot: string,
  sessionName: string,
): Promise<{ ok: true; worktree: SessionWorktree } | { ok: false; error: string }> {
  const absRoot = resolve(repoRoot);
  const branch = `session_${sessionName}`;
  const wtPath = `${WORKTREE_ROOT}/${sessionName}`;

  mkdirSync(WORKTREE_ROOT, { recursive: true });

  if (existsSync(wtPath)) {
    return { ok: true, worktree: { repoRoot: absRoot, branch, path: wtPath } };
  }

  refreshMainInBackground(absRoot);

  // Base the worktree on whichever main is newer. Brand-new projects have no
  // remote yet, so local main must be a complete path rather than a fallback
  // that still assumes origin/main exists.
  const base = await worktreeBaseRef(absRoot);
  if (!base.ok) return base;

  const add = await git(absRoot, ["worktree", "add", "-b", branch, wtPath, base.ref]);
  if (!add.ok) {
    const reuseBranch = await git(absRoot, ["worktree", "add", wtPath, branch]);
    if (!reuseBranch.ok) {
      return {
        ok: false,
        error: add.err.trim() || reuseBranch.err.trim() || "git worktree add failed",
      };
    }
  }

  return { ok: true, worktree: { repoRoot: absRoot, branch, path: wtPath } };
}

export async function resolveSessionCwd(
  repoRoot: string,
  sessionName: string,
  opts?: { worktree?: boolean; selfRepo?: string },
): Promise<
  | { ok: true; cwd: string; worktree?: SessionWorktree }
  | { ok: false; error: string }
> {
  if (!(await shouldAutoWorktree(repoRoot, opts))) {
    return { ok: true, cwd: resolve(repoRoot) };
  }
  const wt = await prepareSessionWorktree(repoRoot, sessionName);
  if (!wt.ok) return { ok: false, error: wt.error };
  return { ok: true, cwd: wt.worktree.path, worktree: wt.worktree };
}

async function repoRootFromWorktree(wtPath: string): Promise<string | null> {
  const r = await git(wtPath, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return null;
  const common = resolve(wtPath, r.out.trim());
  return dirname(common);
}

// Best-effort cleanup — only removes the worktree directory, not the branch.
export async function removeSessionWorktree(
  repoRoot: string | null,
  sessionName: string,
): Promise<boolean> {
  const wtPath = `${WORKTREE_ROOT}/${sessionName}`;
  if (!existsSync(wtPath)) return true;
  const root = repoRoot ? resolve(repoRoot) : await repoRootFromWorktree(wtPath);
  if (!root) return false;
  return (await git(root, ["worktree", "remove", "--force", wtPath])).ok;
}

export type WorktreeSweepResult = {
  scanned: number;
  removed: string[];
  kept: number;
  skippedYoung: number;
  failed: string[];
};

// Drop worktrees whose tmux session is gone. Skips entries still registered as
// managed (startup race) and anything younger than minAgeMs (worktree is
// created a moment before tmux new-session returns).
export async function sweepStaleWorktrees(opts?: {
  minAgeMs?: number;
  now?: number;
}): Promise<WorktreeSweepResult> {
  const minAgeMs = opts?.minAgeMs ?? worktreeSweepMinAgeMs();
  const now = opts?.now ?? Date.now();
  const managed = new Set<string>();
  for (const m of listManaged()) {
    managed.add(m.tmuxName);
    managed.add(basename(m.cwd));
  }
  const result: WorktreeSweepResult = {
    scanned: 0,
    removed: [],
    kept: 0,
    skippedYoung: 0,
    failed: [],
  };

  if (!existsSync(WORKTREE_ROOT)) return result;

  for (const name of readdirSync(WORKTREE_ROOT)) {
    const wtPath = `${WORKTREE_ROOT}/${name}`;
    try {
      if (!statSync(wtPath).isDirectory()) continue;
    } catch {
      continue;
    }
    result.scanned++;

    if (tmuxHasSession(name) || managed.has(name)) {
      result.kept++;
      continue;
    }

    let ageMs = minAgeMs;
    try {
      ageMs = now - statSync(wtPath).mtimeMs;
    } catch {}
    if (ageMs < minAgeMs) {
      result.skippedYoung++;
      continue;
    }

    if (await removeSessionWorktree(null, name)) result.removed.push(name);
    else result.failed.push(name);
  }

  return result;
}

function worktreeSweepIntervalMs(): number {
  const raw = process.env.LFG_WORKTREE_SWEEP_MS;
  if (raw === "0") return 0;
  const n = raw ? parseInt(raw, 10) : 15 * 60_000;
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
}

function worktreeSweepMinAgeMs(): number {
  const raw = process.env.LFG_WORKTREE_SWEEP_MIN_AGE_MS;
  const n = raw ? parseInt(raw, 10) : 2 * 60_000;
  return Number.isFinite(n) && n >= 0 ? n : 2 * 60_000;
}

export function worktreeSweepEnabled(): boolean {
  return sessionWorktreeEnabled() && worktreeSweepIntervalMs() > 0;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export function startWorktreeSweep(onLog: (s: string) => void = () => {}): void {
  const intervalMs = worktreeSweepIntervalMs();
  if (!sessionWorktreeEnabled() || intervalMs === 0) return;
  if (sweepTimer) return;

  const run = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await sweepStaleWorktrees();
      if (r.removed.length || r.failed.length) {
        onLog(
          `[worktree-sweep] scanned=${r.scanned} removed=${r.removed.length}` +
            (r.removed.length ? ` [${r.removed.join(", ")}]` : "") +
            (r.failed.length ? ` failed=[${r.failed.join(", ")}]` : ""),
        );
      }
    } catch (e) {
      onLog(`[worktree-sweep] error: ${e}`);
    } finally {
      sweeping = false;
    }
  };

  sweepTimer = setInterval(run, intervalMs);
  setTimeout(run, 30_000);
  onLog(`[worktree-sweep] started (every ${Math.round(intervalMs / 60_000)}m, min-age ${Math.round(worktreeSweepMinAgeMs() / 1000)}s)`);
}
