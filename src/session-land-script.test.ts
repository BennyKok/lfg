import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployedHeadPath } from "./session-landing.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "land-session.sh");

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

describe("serialized session landing script", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("preserves two concurrent session commits on main", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-land-race-"));
    roots.push(root);
    const remote = join(root, "remote.git");
    const main = join(root, "main");
    const first = join(root, "first");
    const second = join(root, "second");
    const fakeBin = join(root, "bin");
    const bunLog = join(root, "bun-cwds.log");
    mkdirSync(main);
    mkdirSync(join(main, "web"));
    mkdirSync(fakeBin);
    const fakeBun = join(fakeBin, "bun");
    writeFileSync(
      fakeBun,
      "#!/bin/sh\n" +
        "printf '%s\\n' \"$PWD\" >> \"$LFG_TEST_BUN_LOG\"\n" +
        "case \"$PWD\" in\n" +
        "  */web) mkdir -p dist; printf '<!doctype html><html></html>\\n' > dist/index.html ;;\n" +
        "esac\n",
    );
    chmodSync(fakeBun, 0o755);
    git(root, "init", "--bare", remote);
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "test@example.com");
    git(main, "config", "user.name", "Test");
    git(main, "remote", "add", "origin", remote);
    writeFileSync(join(main, "base.txt"), "base\n");
    writeFileSync(join(main, ".gitignore"), "web/dist/\n");
    writeFileSync(join(main, "web", ".keep"), "\n");
    git(main, "add", ".gitignore", "base.txt", "web/.keep");
    git(main, "commit", "-m", "base");
    git(main, "push", "-u", "origin", "main");
    git(main, "worktree", "add", "-b", "session_first", first, "main");
    git(main, "worktree", "add", "-b", "session_second", second, "main");

    writeFileSync(join(first, "first.txt"), "first\n");
    git(first, "add", "first.txt");
    git(first, "commit", "-m", "first");
    writeFileSync(join(second, "second.txt"), "second\n");
    git(second, "add", "second.txt");
    git(second, "commit", "-m", "second");

    const env = {
      ...process.env,
      LFG_LAND_SKIP_RESTART: "1",
      LFG_TEST_BUN_LOG: bunLog,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };
    const one = Bun.spawn(["bash", SCRIPT], { cwd: first, env, stdout: "pipe", stderr: "pipe" });
    const two = Bun.spawn(["bash", SCRIPT], { cwd: second, env, stdout: "pipe", stderr: "pipe" });
    const [oneCode, twoCode] = await Promise.all([one.exited, two.exited]);
    const diagnostics = [
      await new Response(one.stdout).text(),
      await new Response(one.stderr).text(),
      await new Response(two.stdout).text(),
      await new Response(two.stderr).text(),
    ].join("\n");
    expect(oneCode, diagnostics).toBe(0);
    expect(twoCode, diagnostics).toBe(0);

    git(main, "fetch", "origin", "main");
    expect(git(main, "show", "origin/main:first.txt")).toBe("first");
    expect(git(main, "show", "origin/main:second.txt")).toBe("second");
    expect(git(main, "rev-parse", "HEAD")).toBe(git(main, "rev-parse", "origin/main"));
    expect(Bun.file(deployedHeadPath(main)!).text()).resolves.toBe(
      `${git(main, "rev-parse", "origin/main")}\n`,
    );
    const buildCwds = (await Bun.file(bunLog).text()).trim().split("\n");
    expect(buildCwds).toHaveLength(6);
    expect(buildCwds.filter((cwd) => cwd === main)).toHaveLength(2);
    expect(buildCwds.filter((cwd) => cwd === join(main, "web"))).toHaveLength(4);
  });
});
