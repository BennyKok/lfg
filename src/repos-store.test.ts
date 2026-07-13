import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { createProjectFolder } from "./repos-store.ts";
import { prepareSessionWorktree, WORKTREE_ROOT } from "./worktree.ts";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

describe("project creation", () => {
  const originalData = PATHS.data;
  const roots: string[] = [];
  const worktreeSessions: Array<{ repo: string; session: string }> = [];

  afterEach(() => {
    PATHS.data = originalData;
    for (const { repo, session } of worktreeSessions.splice(0)) {
      Bun.spawnSync(["git", "-C", repo, "worktree", "remove", "--force", join(WORKTREE_ROOT, session)]);
      Bun.spawnSync(["git", "-C", repo, "branch", "-D", `session_${session}`]);
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("creates a committed main branch that can back an isolated session worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-project-create-"));
    roots.push(root);
    PATHS.data = join(root, "data");

    const repo = await createProjectFolder(root, "test");

    expect(git(repo.cwd, "branch", "--show-current")).toBe("main");
    expect(git(repo.cwd, "show", "HEAD:README.md")).toBe("# test");
    expect(git(repo.cwd, "status", "--short")).toBe("");
    expect(JSON.parse(readFileSync(join(PATHS.data, "custom-repos.json"), "utf8"))).toEqual([
      { name: "test", cwd: repo.cwd },
    ]);

    const session = `repo-init-${crypto.randomUUID().slice(0, 8)}`;
    worktreeSessions.push({ repo: repo.cwd, session });
    const worktree = prepareSessionWorktree(repo.cwd, session);

    expect(worktree.ok).toBe(true);
    if (!worktree.ok) return;
    expect(git(worktree.worktree.path, "rev-parse", "HEAD")).toBe(git(repo.cwd, "rev-parse", "HEAD"));
  });

  test("removes the project directory when registration fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-project-rollback-"));
    roots.push(root);
    PATHS.data = join(root, "blocked-data");
    writeFileSync(PATHS.data, "not a directory");

    await expect(createProjectFolder(root, "test")).rejects.toThrow();

    expect(existsSync(join(root, "test"))).toBe(false);
  });
});
