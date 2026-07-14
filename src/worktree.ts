// Auto-provision an isolated git worktree per lfg-managed session so agents
// never collide on a shared checkout (see docs/repo-hygiene.md). Skipped for
// lfg itself and voice-orchestrator sessions.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { MAIN_REF } from "./agents/collectors/git-fresh.ts";
import { listManaged } from "./managed.ts";
import { tmuxHasSession } from "./tmux.ts";

export const WORKTREE_ROOT = "/tmp/lfg-wt";

export type SessionWorktree = {
  repoRoot: string;
  branch: string;
  path: string;
};

function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

export function isGitRepo(path: string): boolean {
  return git(resolve(path), ["rev-parse", "--git-dir"]).ok;
}

function hasHeadCommit(path: string): boolean {
  return git(resolve(path), ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
}

export function sessionWorktreeEnabled(): boolean {
  return process.env.LFG_SESSION_WORKTREE !== "0";
}

export function shouldAutoWorktree(
  repoRoot: string,
  opts?: { voice?: boolean; worktree?: boolean; selfRepo?: string },
): boolean {
  if (opts?.worktree === false) return false;
  const abs = resolve(repoRoot);
  // Explicit `worktree: true` is a hard opt-in: it overrides the default-off
  // guards (global disable, voice, and the self-repo skip) so an agent asked to
  // isolate ALWAYS lands in /tmp/lfg-wt instead of editing a shared checkout in
  // place. This is what lets an lfg subagent safely rewrite serve.ts/App.tsx
  // without colliding with the ~15 sessions live in the shared tree.
  if (opts?.worktree === true) return isGitRepo(abs);
  // Otherwise fall back to the auto policy: on by default, but skip lfg-self
  // and the voice orchestrator.
  if (!sessionWorktreeEnabled()) return false;
  if (opts?.voice) return false;
  if (opts?.selfRepo && resolve(opts.selfRepo) === abs) return false;
  // "Use this folder" can initialize an existing directory as an unborn Git
  // repository. There is no commit from which Git can create a worktree yet,
  // but the first coding agent still needs to launch so it can inspect the
  // existing files and make that commit. Run that first session in place;
  // subsequent sessions regain normal worktree isolation once HEAD exists.
  return isGitRepo(abs) && hasHeadCommit(abs);
}

function worktreeBaseRef(repo: string): { ok: true; ref: string } | { ok: false; error: string } {
  const remoteMain = git(repo, ["rev-parse", "--verify", "--quiet", MAIN_REF]);
  const localMain = git(repo, ["rev-parse", "--verify", "--quiet", "main"]);

  if (localMain.ok) {
    if (!remoteMain.ok) return { ok: true, ref: "main" };
    const ahead = git(repo, ["rev-list", "--count", `${MAIN_REF}..main`]);
    if (ahead.ok && parseInt(ahead.out.trim(), 10) > 0) return { ok: true, ref: "main" };
    return { ok: true, ref: MAIN_REF };
  }
  if (remoteMain.ok) return { ok: true, ref: MAIN_REF };

  // Imported local repositories may use another default branch. A real HEAD is
  // sufficient; an unborn repository is not, because Git cannot make a
  // worktree without a commit to branch from.
  const head = git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.ok) return { ok: true, ref: "HEAD" };
  return { ok: false, error: "repository has no commits; create an initial commit first" };
}

// Create (or reuse) a per-session worktree from the newest usable main ref.
export function prepareSessionWorktree(
  repoRoot: string,
  sessionName: string,
): { ok: true; worktree: SessionWorktree } | { ok: false; error: string } {
  const absRoot = resolve(repoRoot);
  const branch = `session_${sessionName}`;
  const wtPath = `${WORKTREE_ROOT}/${sessionName}`;

  mkdirSync(WORKTREE_ROOT, { recursive: true });

  if (existsSync(wtPath)) {
    return { ok: true, worktree: { repoRoot: absRoot, branch, path: wtPath } };
  }

  git(absRoot, ["fetch", "--quiet", "origin", "main"]);

  // Base the worktree on whichever main is newer. Brand-new projects have no
  // remote yet, so local main must be a complete path rather than a fallback
  // that still assumes origin/main exists.
  const base = worktreeBaseRef(absRoot);
  if (!base.ok) return base;

  const add = git(absRoot, ["worktree", "add", "-b", branch, wtPath, base.ref]);
  if (!add.ok) {
    const reuseBranch = git(absRoot, ["worktree", "add", wtPath, branch]);
    if (!reuseBranch.ok) {
      return {
        ok: false,
        error: add.err.trim() || reuseBranch.err.trim() || "git worktree add failed",
      };
    }
  }

  return { ok: true, worktree: { repoRoot: absRoot, branch, path: wtPath } };
}

export function resolveSessionCwd(
  repoRoot: string,
  sessionName: string,
  opts?: { voice?: boolean; worktree?: boolean; selfRepo?: string },
):
  | { ok: true; cwd: string; worktree?: SessionWorktree }
  | { ok: false; error: string } {
  if (!shouldAutoWorktree(repoRoot, opts)) {
    return { ok: true, cwd: resolve(repoRoot) };
  }
  const wt = prepareSessionWorktree(repoRoot, sessionName);
  if (!wt.ok) return { ok: false, error: wt.error };
  return { ok: true, cwd: wt.worktree.path, worktree: wt.worktree };
}

function repoRootFromWorktree(wtPath: string): string | null {
  const r = git(wtPath, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return null;
  const common = resolve(wtPath, r.out.trim());
  return dirname(common);
}

// Best-effort cleanup — only removes the worktree directory, not the branch.
export function removeSessionWorktree(
  repoRoot: string | null,
  sessionName: string,
): boolean {
  const wtPath = `${WORKTREE_ROOT}/${sessionName}`;
  if (!existsSync(wtPath)) return true;
  const root = repoRoot ? resolve(repoRoot) : repoRootFromWorktree(wtPath);
  if (!root) return false;
  return git(root, ["worktree", "remove", "--force", wtPath]).ok;
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
export function sweepStaleWorktrees(opts?: {
  minAgeMs?: number;
  now?: number;
}): WorktreeSweepResult {
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

    if (removeSessionWorktree(null, name)) result.removed.push(name);
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

  const run = () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = sweepStaleWorktrees();
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
