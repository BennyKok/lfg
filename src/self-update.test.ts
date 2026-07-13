import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceUpdateStatus } from "./self-update.ts";

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lfg-self-update-"));
  cleanup.push(root);
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  Bun.spawnSync(["git", "init", "--bare", remote]);
  Bun.spawnSync(["git", "init", "-b", "main", checkout]);
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test User");
  writeFileSync(join(checkout, "version.txt"), "one\n");
  git(checkout, "add", "version.txt");
  git(checkout, "commit", "-m", "initial");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "-u", "origin", "main");
  return { root, remote, checkout };
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("source update status", () => {
  test("reports an up-to-date main checkout", async () => {
    const { checkout } = fixture();
    const status = await sourceUpdateStatus(checkout);
    expect(status.state).toBe("up-to-date");
    expect(status.currentSha).toBe(status.latestSha);
  });

  test("reports commits available from origin/main", async () => {
    const { root, remote, checkout } = fixture();
    const publisher = join(root, "publisher");
    Bun.spawnSync(["git", "clone", "-b", "main", remote, publisher]);
    git(publisher, "config", "user.email", "test@example.com");
    git(publisher, "config", "user.name", "Test User");
    writeFileSync(join(publisher, "version.txt"), "two\n");
    git(publisher, "commit", "-am", "update");
    git(publisher, "push", "origin", "main");

    const status = await sourceUpdateStatus(checkout);
    expect(status.state).toBe("available");
    expect(status.commitsBehind).toBe(1);
  });

  test("blocks local changes and non-main branches", async () => {
    const { checkout } = fixture();
    writeFileSync(join(checkout, "local.txt"), "local\n");
    expect((await sourceUpdateStatus(checkout, false)).state).toBe("blocked");
    rmSync(join(checkout, "local.txt"));
    git(checkout, "switch", "-c", "feature");
    const status = await sourceUpdateStatus(checkout, false);
    expect(status.state).toBe("blocked");
    expect(status.message).toContain("feature");
  });
});
