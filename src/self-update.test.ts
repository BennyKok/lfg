import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractReleaseArchive,
  releaseUpdateStatus,
  restartCommand,
  sourceUpdateStatus,
} from "./self-update.ts";

const cleanup: string[] = [];
const realFetch = globalThis.fetch;

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
  globalThis.fetch = realFetch;
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

describe("release update status", () => {
  test("compares the installed package version with the latest release tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-release-update-"));
    cleanup.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lfg", version: "1.2.3" }));
    globalThis.fetch = (async () => Response.json({ tag_name: "v1.3.0" })) as unknown as typeof fetch;

    const status = await releaseUpdateStatus(root, { repoSlug: "example/lfg-release-test" });
    expect(status.state).toBe("available");
    expect(status.currentVersion).toBe("1.2.3");
    expect(status.latestVersion).toBe("1.3.0");
  });

  test("recognizes a matching v-prefixed release tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-release-update-"));
    cleanup.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lfg", version: "2.0.0" }));
    globalThis.fetch = (async () => Response.json({ tag_name: "v2.0.0" })) as unknown as typeof fetch;

    const status = await releaseUpdateStatus(root, { repoSlug: "example/lfg-current-test" });
    expect(status.state).toBe("up-to-date");
  });
});

describe("release extraction", () => {
  test("overwrites bundle files even when the host injects keep-old-files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-release-extract-"));
    cleanup.push(root);
    const stage = join(root, "stage");
    const target = join(root, "target");
    const archive = join(root, "bundle.tar.gz");
    mkdirSync(join(stage, "lfg", "src"), { recursive: true });
    mkdirSync(join(target, "src"), { recursive: true });
    writeFileSync(join(stage, "lfg", "src", "index.ts"), "new\n");
    writeFileSync(join(target, "src", "index.ts"), "old\n");
    const packed = Bun.spawnSync(["tar", "-C", stage, "-czf", archive, "lfg"]);
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);

    const priorTarOptions = process.env.TAR_OPTIONS;
    process.env.TAR_OPTIONS = "--keep-old-files";
    try {
      const extracted = await extractReleaseArchive(archive, target);
      expect(extracted.ok, extracted.stderr).toBe(true);
    } finally {
      if (priorTarOptions === undefined) delete process.env.TAR_OPTIONS;
      else process.env.TAR_OPTIONS = priorTarOptions;
    }
    expect(readFileSync(join(target, "src", "index.ts"), "utf8")).toBe("new\n");
  });
});

describe("restart command", () => {
  test("recognizes the OMG agent-template supervisor", () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-omg-restart-"));
    cleanup.push(root);
    const home = join(root, "home");
    const procRoot = join(root, "proc");
    const supervisorPid = 4242;
    mkdirSync(join(home, ".omg"), { recursive: true });
    mkdirSync(join(procRoot, String(supervisorPid)), { recursive: true });
    writeFileSync(join(home, ".omg", "agent-serve.sh"), "#!/bin/sh\n");
    writeFileSync(join(home, ".omg", "agent-serve.pid"), `${supervisorPid}\n`);
    writeFileSync(
      join(procRoot, String(supervisorPid), "cmdline"),
      `bash\0${join(home, ".omg", "agent-serve.sh")}\0`,
    );

    const command = restartCommand("linux", home, procRoot);
    expect(command?.slice(1)).toEqual(["-TERM", String(process.pid)]);
    expect(command?.[0].endsWith("/kill")).toBe(true);
  });

  test("does not trust a stale OMG supervisor pidfile", () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-omg-restart-"));
    cleanup.push(root);
    const home = join(root, "home");
    const procRoot = join(root, "proc");
    mkdirSync(join(home, ".omg"), { recursive: true });
    mkdirSync(join(procRoot, "4242"), { recursive: true });
    writeFileSync(join(home, ".omg", "agent-serve.sh"), "#!/bin/sh\n");
    writeFileSync(join(home, ".omg", "agent-serve.pid"), "4242\n");
    writeFileSync(join(procRoot, "4242", "cmdline"), "unrelated-process\0");

    expect(restartCommand("linux", home, procRoot)).toBeNull();
  });
});
