// Session creation provisions a git worktree, and that provisioning used to run
// `git fetch origin main` synchronously on EVERY create — a network round trip
// that blocks Bun's single event loop, so every other session's live stream and
// every unrelated API call waited behind it.
//
// These tests pin the guard that bounds it: the fetch is refreshed at most once
// per repo per TTL window, and skipping it still produces a usable worktree.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSessionWorktree, WORKTREE_ROOT } from "./worktree.ts";

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr.toString()}`).toBe(0);
  return r.stdout.toString().trim();
}

const roots: string[] = [];
const sessions: string[] = [];

afterAll(() => {
  for (const session of sessions) {
    Bun.spawnSync(["git", "worktree", "remove", "--force", join(WORKTREE_ROOT, session)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    rmSync(join(WORKTREE_ROOT, session), { recursive: true, force: true });
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// An "origin" repo plus a clone of it, so a fetch has something real to observe.
function makeClonedRepo(): { origin: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "lfg-wt-fetch-"));
  roots.push(root);
  const origin = join(root, "origin");
  const work = join(root, "work");

  Bun.spawnSync(["git", "init", "-q", "-b", "main", origin], { stdout: "ignore", stderr: "ignore" });
  git(origin, "config", "user.email", "t@example.com");
  git(origin, "config", "user.name", "t");
  Bun.write(join(origin, "a.txt"), "first\n");
  git(origin, "add", "a.txt");
  git(origin, "commit", "-qm", "first");

  Bun.spawnSync(["git", "clone", "-q", origin, work], { stdout: "ignore", stderr: "ignore" });
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  return { origin, work };
}

function newSessionName(): string {
  const name = `wtfetch-${Math.random().toString(16).slice(2, 10)}`;
  sessions.push(name);
  return name;
}

describe("session worktree origin/main fetch", () => {
  test("the first create for a repo fetches, so it branches from current origin/main", () => {
    const { origin, work } = makeClonedRepo();
    // Advance origin BEFORE the clone's very first provisioning. The clone has
    // not seen this commit, so only a real fetch can reach it.
    Bun.write(join(origin, "b.txt"), "second\n");
    git(origin, "add", "b.txt");
    git(origin, "commit", "-qm", "second");
    const originHead = git(origin, "rev-parse", "HEAD");

    const session = newSessionName();
    const result = prepareSessionWorktree(work, session);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(git(result.worktree.path, "rev-parse", "HEAD")).toBe(originHead);
  });

  test("a second create within the TTL skips the fetch instead of paying it again", () => {
    const { origin, work } = makeClonedRepo();

    // First create warms the per-repo fetch timestamp.
    const first = prepareSessionWorktree(work, newSessionName());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const baseHead = git(first.worktree.path, "rev-parse", "HEAD");

    // Now move origin forward. A second create in the same TTL window must NOT
    // go to the network, so it branches from the origin/main already on disk.
    Bun.write(join(origin, "c.txt"), "third\n");
    git(origin, "add", "c.txt");
    git(origin, "commit", "-qm", "third");
    expect(git(origin, "rev-parse", "HEAD")).not.toBe(baseHead);

    const second = prepareSessionWorktree(work, newSessionName());
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same base as the first create — proof the fetch was skipped, and that
    // skipping still yields a working worktree rather than an error.
    expect(git(second.worktree.path, "rev-parse", "HEAD")).toBe(baseHead);
  });

  test("an unreachable remote still produces a worktree from the local main", () => {
    const { origin, work } = makeClonedRepo();
    const localHead = git(work, "rev-parse", "HEAD");
    // Point origin at a path that does not exist: the fetch fails rather than
    // hanging, and provisioning must fall through to the refs already present.
    git(work, "remote", "set-url", "origin", join(origin, "..", "gone.git"));

    const result = prepareSessionWorktree(work, newSessionName());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(result.worktree.path, "rev-parse", "HEAD")).toBe(localHead);
  });
});
