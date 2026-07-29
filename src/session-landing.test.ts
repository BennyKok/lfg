import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSession } from "./managed.ts";
import { deployedHeadPath, verifySelfRepoLanding } from "./session-landing.ts";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

describe("self-repo session landing guard", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): {
    root: string;
    main: string;
    worktree: string;
    managed: ManagedSession;
  } {
    const root = mkdtempSync(join(tmpdir(), "lfg-session-landing-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    const main = join(root, "main");
    const worktree = join(root, "session");
    mkdirSync(main);
    git(root, "init", "--bare", remote);
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "test@example.com");
    git(main, "config", "user.name", "Test");
    git(main, "remote", "add", "origin", remote);
    writeFileSync(join(main, "base.txt"), "base\n");
    git(main, "add", "base.txt");
    git(main, "commit", "-m", "base");
    git(main, "push", "-u", "origin", "main");
    git(main, "worktree", "add", "-b", "session_test", worktree, "main");

    return {
      root,
      main,
      worktree,
      managed: {
        tmuxName: "lfg-test",
        cwd: worktree,
        createdAt: Date.now(),
        agent: "codex",
        sessionId: "session-id",
        repoRoot: main,
        worktreeBranch: "session_test",
      },
    };
  }

  test("rejects dirty, unmerged, unsynced, and undeployed session states", () => {
    const { main, worktree, managed } = fixture();

    writeFileSync(join(worktree, "feature.txt"), "feature\n");
    expect(verifySelfRepoLanding(managed, main)).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining("uncommitted") }),
    );

    git(worktree, "add", "feature.txt");
    git(worktree, "commit", "-m", "feature");
    expect(verifySelfRepoLanding(managed, main)).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining("origin/main") }),
    );

    git(worktree, "push", "origin", "HEAD:main");
    expect(verifySelfRepoLanding(managed, main)).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining("not synced") }),
    );

    git(main, "pull", "--ff-only");
    expect(verifySelfRepoLanding(managed, main)).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringContaining("not been built") }),
    );

    const marker = deployedHeadPath(main);
    expect(marker).not.toBeNull();
    writeFileSync(marker!, `${git(main, "rev-parse", "HEAD")}\n`);
    expect(verifySelfRepoLanding(managed, main)).toEqual({
      ok: true,
      head: git(main, "rev-parse", "HEAD"),
    });
  });

  test("does not impose LFG deployment policy on another repository", () => {
    const { main, managed } = fixture();
    expect(verifySelfRepoLanding(managed, join(main, "some-other-repo"))).toEqual({
      ok: true,
      head: "",
    });
  });
});
