// Shipping from an LFG-owned worktree is a source-control terminal state, not
// merely a feed post. For LFG's own repository we can verify the entire local
// delivery chain: clean session worktree -> remote main -> clean local main ->
// build/restart marker written by scripts/land-session.sh.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ManagedSession } from "./managed.ts";

const MAIN_REF = "origin/main";
const DEPLOYED_HEAD_FILE = "lfg-deployed-head";

type GitResult = { ok: boolean; out: string; err: string };

function git(cwd: string, args: string[]): GitResult {
  const proc = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: proc.exitCode === 0,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString().trim(),
  };
}

export type SessionLandingResult =
  | { ok: true; head: string }
  | { ok: false; error: string };

export function deployedHeadPath(repoRoot: string): string | null {
  const common = git(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.out) return null;
  return resolve(repoRoot, common.out, DEPLOYED_HEAD_FILE);
}

function fail(detail: string): SessionLandingResult {
  return {
    ok: false,
    error:
      `${detail} Run scripts/land-session.sh from the session worktree, ` +
      "resolve any reported conflict, then ship again.",
  };
}

function branchChangesReachedMain(cwd: string): boolean {
  const ancestor = git(cwd, ["merge-base", "--is-ancestor", "HEAD", MAIN_REF]);
  if (ancestor.ok) return true;

  // PRs are normally squash-merged, so the worktree commit itself is not an
  // ancestor of main. `git cherry` marks patch-equivalent commits with "-";
  // any "+" means work from this branch is still absent from remote main.
  const cherry = git(cwd, ["cherry", MAIN_REF, "HEAD"]);
  if (!cherry.ok) return false;
  return cherry.out
    .split("\n")
    .filter(Boolean)
    .every((line) => line.startsWith("-"));
}

export function verifySelfRepoLanding(
  managed: ManagedSession | undefined,
  selfRepo: string,
): SessionLandingResult {
  // Historical, attached, and non-worktree sessions retain their existing ship
  // semantics. New LFG coding sessions always carry both fields.
  if (!managed?.repoRoot || !managed.worktreeBranch) {
    return { ok: true, head: "" };
  }
  if (resolve(managed.repoRoot) !== resolve(selfRepo)) {
    return { ok: true, head: "" };
  }

  const cwd = resolve(managed.cwd);
  if (!existsSync(cwd)) return fail("The session worktree no longer exists.");

  const status = git(cwd, ["status", "--porcelain"]);
  if (!status.ok) return fail("The session worktree is not a readable Git checkout.");
  if (status.out) return fail("The session worktree still has uncommitted changes.");

  const fetch = git(cwd, ["fetch", "--quiet", "origin", "main"]);
  if (!fetch.ok) return fail(`Could not refresh origin/main: ${fetch.err || "git fetch failed"}.`);

  const head = git(cwd, ["rev-parse", "HEAD"]);
  const remote = git(cwd, ["rev-parse", MAIN_REF]);
  if (!head.ok || !remote.ok) return fail("Could not resolve the session or origin/main revision.");
  if (!branchChangesReachedMain(cwd)) {
    return fail("This session's committed changes have not reached origin/main.");
  }

  const deployBranch = git(selfRepo, ["branch", "--show-current"]);
  if (!deployBranch.ok || deployBranch.out !== "main") {
    return fail("The local LFG deployment checkout is not on main.");
  }
  const deployStatus = git(selfRepo, ["status", "--porcelain"]);
  if (!deployStatus.ok || deployStatus.out) {
    return fail("The local LFG deployment checkout is not clean.");
  }
  const deployHead = git(selfRepo, ["rev-parse", "HEAD"]);
  if (!deployHead.ok || deployHead.out !== remote.out) {
    return fail("The local LFG deployment checkout is not synced to origin/main.");
  }

  const marker = deployedHeadPath(selfRepo);
  let deployed = "";
  try {
    deployed = marker ? readFileSync(marker, "utf8").trim() : "";
  } catch {}
  if (deployed !== remote.out) {
    return fail("The current origin/main revision has not been built and restarted locally.");
  }

  return { ok: true, head: remote.out };
}
