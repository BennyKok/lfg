import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeSessionDiff, computeSessionDiffStat } from "./session-diff.ts";
import { WORKTREE_ROOT } from "./worktree.ts";

const repos: string[] = [];
const worktrees: Array<{ repo: string; path: string }> = [];

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): { repo: string; worktree: string; branch: string } {
  const id = crypto.randomUUID();
  const repo = join("/tmp", `lfg-session-diff-${id}`);
  const worktree = join(WORKTREE_ROOT, `session-diff-${id}`);
  const branch = `session_${id.replaceAll("-", "")}`;
  mkdirSync(repo, { recursive: true });
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(repo, "worktree", "add", "-b", branch, worktree, "HEAD");
  repos.push(repo);
  worktrees.push({ repo, path: worktree });
  return { repo, worktree, branch };
}

afterEach(() => {
  while (worktrees.length) {
    const item = worktrees.pop()!;
    Bun.spawnSync(["git", "-C", item.repo, "worktree", "remove", "--force", item.path]);
  }
  while (repos.length) rmSync(repos.pop()!, { recursive: true, force: true });
});

describe("session diff merge state", () => {
  test("marks a clean branch merged once HEAD is contained in origin/main", () => {
    const { repo, worktree, branch } = fixture();
    writeFileSync(join(worktree, "file.txt"), "base\nfeature\n");
    git(worktree, "add", "file.txt");
    git(worktree, "commit", "-m", "feature");

    expect(computeSessionDiffStat(worktree).merged).toBe(false);

    git(repo, "merge", "--no-ff", branch, "-m", "merge feature");
    git(repo, "update-ref", "refs/remotes/origin/main", "main");

    expect(computeSessionDiffStat(worktree).merged).toBe(true);
    expect(computeSessionDiff(worktree).merged).toBe(true);
  });

  test("keeps post-merge local edits in review", () => {
    const { repo, worktree, branch } = fixture();
    writeFileSync(join(worktree, "file.txt"), "base\nfeature\n");
    git(worktree, "add", "file.txt");
    git(worktree, "commit", "-m", "feature");
    git(repo, "merge", "--no-ff", branch, "-m", "merge feature");
    git(repo, "update-ref", "refs/remotes/origin/main", "main");
    writeFileSync(join(worktree, "file.txt"), "base\nfeature\nmore work\n");

    expect(computeSessionDiffStat(worktree).merged).toBe(false);
  });

  test("keeps post-merge commits in review", () => {
    const { repo, worktree, branch } = fixture();
    writeFileSync(join(worktree, "file.txt"), "base\nfeature\n");
    git(worktree, "add", "file.txt");
    git(worktree, "commit", "-m", "feature");
    git(repo, "merge", "--no-ff", branch, "-m", "merge feature");
    git(repo, "update-ref", "refs/remotes/origin/main", "main");

    writeFileSync(join(worktree, "file.txt"), "base\nfeature\nmore work\n");
    git(worktree, "add", "file.txt");
    git(worktree, "commit", "-m", "more work");

    expect(computeSessionDiffStat(worktree).merged).toBe(false);
  });
});
