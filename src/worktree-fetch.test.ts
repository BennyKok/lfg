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

// Wait for the background refresh to land origin/main on disk.
async function waitForOriginMain(work: string, want: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    if (git(work, "rev-parse", "origin/main") === want) return want;
    await Bun.sleep(50);
  }
  return git(work, "rev-parse", "origin/main");
}

describe("session worktree origin/main fetch", () => {
  test("a create does not wait for the network, however slow the remote is", async () => {
    const { work } = makeClonedRepo();
    const localHead = git(work, "rev-parse", "HEAD");
    // A blackholed address: packets are dropped rather than refused, so the
    // fetch hangs until its own 10s timeout. Waiting for it would be plainly
    // visible here — which is what this used to do, and what the whole change
    // is about. Asserting on elapsed time rather than on which ref got picked,
    // because a fast remote can legitimately land its background refresh
    // before the base ref is read.
    git(work, "remote", "set-url", "origin", "https://10.255.255.1/hangs.git");

    const started = performance.now();
    const result = await prepareSessionWorktree(work, newSessionName());
    const elapsedMs = performance.now() - started;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(elapsedMs).toBeLessThan(3_000);
    expect(git(result.worktree.path, "rev-parse", "HEAD")).toBe(localHead);
  });

  test("the refresh it kicks off in the background benefits the next create", async () => {
    const { origin, work } = makeClonedRepo();
    Bun.write(join(origin, "b.txt"), "second\n");
    git(origin, "add", "b.txt");
    git(origin, "commit", "-qm", "second");
    const originHead = git(origin, "rev-parse", "HEAD");

    // This create starts the fetch and returns without it.
    const first = await prepareSessionWorktree(work, newSessionName());
    expect(first.ok).toBe(true);
    expect(await waitForOriginMain(work, originHead)).toBe(originHead);

    // Second create branches from the ref the background fetch brought in —
    // freshness is preserved, it is just paid for out of band.
    const second = await prepareSessionWorktree(work, newSessionName());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(git(second.worktree.path, "rev-parse", "HEAD")).toBe(originHead);
  });

  test("a second create within the TTL does not fetch again", async () => {
    const { origin, work } = makeClonedRepo();

    // First create warms the per-repo fetch timestamp.
    const first = await prepareSessionWorktree(work, newSessionName());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const baseHead = git(first.worktree.path, "rev-parse", "HEAD");

    // Now move origin forward. A second create in the same TTL window must not
    // go to the network at all, so origin/main on disk stays where it was.
    Bun.write(join(origin, "c.txt"), "third\n");
    git(origin, "add", "c.txt");
    git(origin, "commit", "-qm", "third");
    expect(git(origin, "rev-parse", "HEAD")).not.toBe(baseHead);

    const second = await prepareSessionWorktree(work, newSessionName());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await Bun.sleep(300);
    expect(git(work, "rev-parse", "origin/main")).toBe(baseHead);
    expect(git(second.worktree.path, "rev-parse", "HEAD")).toBe(baseHead);
  });

  test("an unreachable remote still produces a worktree from the local main", async () => {
    const { origin, work } = makeClonedRepo();
    const localHead = git(work, "rev-parse", "HEAD");
    // Point origin at a path that does not exist: the failing background fetch
    // must not touch provisioning, which uses the refs already present.
    git(work, "remote", "set-url", "origin", join(origin, "..", "gone.git"));

    const result = await prepareSessionWorktree(work, newSessionName());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(git(result.worktree.path, "rev-parse", "HEAD")).toBe(localHead);
  });
});
