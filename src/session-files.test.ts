import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FILES_CEILING,
  isDeniedPath,
  listSessionTree,
  readSessionFile,
  resolveBrowsePath,
} from "./session-files.ts";

// Fixtures live under the home directory because the browsing ceiling defaults
// to it — anything in /tmp would be rejected before the logic under test runs.
const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function fixture(): string {
  const dir = join(homedir(), `.lfg-files-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("resolveBrowsePath", () => {
  test("resolves a relative target against the session cwd", () => {
    const dir = fixture();
    mkdirSync(join(dir, "sub"));
    expect(resolveBrowsePath(dir, "sub")).toBe(join(dir, "sub"));
  });

  test("allows navigating up while inside the ceiling", () => {
    const dir = fixture();
    expect(resolveBrowsePath(dir, "..")).toBe(FILES_CEILING);
  });

  test("rejects traversal above the ceiling", () => {
    const dir = fixture();
    expect(resolveBrowsePath(dir, "../../..")).toBeNull();
    expect(resolveBrowsePath(dir, "/etc")).toBeNull();
    expect(resolveBrowsePath(dir, "/etc/passwd")).toBeNull();
  });

  test("rejects secrets even inside the ceiling", () => {
    const dir = fixture();
    expect(resolveBrowsePath(dir, ".env")).toBeNull();
    expect(resolveBrowsePath(dir, ".env.production")).toBeNull();
    expect(resolveBrowsePath(dir, "deploy/server.pem")).toBeNull();
    expect(resolveBrowsePath(homedir(), ".ssh/id_ed25519")).toBeNull();
    expect(resolveBrowsePath(homedir(), ".claude/.credentials.json")).toBeNull();
  });
});

describe("isDeniedPath", () => {
  test("denies any file under a secrets directory", () => {
    expect(isDeniedPath("/home/dev/.ssh/known_hosts")).toBe(true);
    expect(isDeniedPath("/home/dev/.aws/config")).toBe(true);
    expect(isDeniedPath("/home/dev/project/src/index.ts")).toBe(false);
  });
});

describe("listSessionTree", () => {
  test("lists tracked and untracked files with git status badges", () => {
    const dir = fixture();
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "user.name", "Test User");
    writeFileSync(join(dir, "tracked.md"), "hello\n");
    git(dir, "add", "tracked.md");
    git(dir, "commit", "-m", "base");
    mkdirSync(join(dir, "videos", "shorts"), { recursive: true });
    writeFileSync(join(dir, "videos", "shorts", "plan.md"), "new\n");
    writeFileSync(join(dir, "tracked.md"), "changed\n");

    const tree = listSessionTree(dir);
    expect(tree.ok).toBe(true);
    expect(tree.root).toBe(dir);
    expect(tree.paths).toContain("tracked.md");
    expect(tree.paths).toContain("videos/shorts/plan.md");
    expect(tree.gitStatus).toContainEqual({ path: "tracked.md", status: "modified" });
    expect(tree.gitStatus).toContainEqual({ path: "videos/shorts/plan.md", status: "untracked" });
  });

  test("excludes secrets from the listing", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".env"), "TOKEN=hunter2\n");
    writeFileSync(join(dir, "README.md"), "hi\n");

    const tree = listSessionTree(dir);
    expect(tree.paths).toContain("README.md");
    expect(tree.paths).not.toContain(".env");
  });

  test("walks a plain directory outside a repo", () => {
    const dir = fixture();
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "a.txt"), "a\n");

    const tree = listSessionTree(dir);
    expect(tree.ok).toBe(true);
    expect(tree.paths).toEqual(["notes/a.txt"]);
  });

  test("reports a parent for the breadcrumb and stops at the ceiling", () => {
    const dir = fixture();
    expect(listSessionTree(dir).parent).toBe(FILES_CEILING);
    expect(listSessionTree(FILES_CEILING, FILES_CEILING).parent).toBeNull();
  });

  test("refuses a root above the ceiling", () => {
    const dir = fixture();
    const tree = listSessionTree(dir, "/etc");
    expect(tree.ok).toBe(false);
    expect(tree.paths).toEqual([]);
  });
});

describe("readSessionFile", () => {
  test("returns contents shaped for the diffs viewer", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "shoot-day.md"), "# Shoot day\n");

    const file = await readSessionFile(dir, "shoot-day.md");
    expect(file).toMatchObject({ name: "shoot-day.md", contents: "# Shoot day\n", binary: false });
  });

  test("flags binary files instead of returning their bytes", async () => {
    const dir = fixture();
    writeFileSync(join(dir, "clip.bin"), new Uint8Array([0x00, 0x01, 0x02, 0x00]));

    const file = await readSessionFile(dir, "clip.bin");
    expect(file).toMatchObject({ binary: true, contents: "" });
  });

  test("refuses to read outside the ceiling or a secret inside it", async () => {
    const dir = fixture();
    writeFileSync(join(dir, ".env"), "TOKEN=hunter2\n");

    expect(await readSessionFile(dir, "/etc/passwd")).toEqual({ error: "path outside the browsable root" });
    expect(await readSessionFile(dir, ".env")).toEqual({ error: "path outside the browsable root" });
  });
});
