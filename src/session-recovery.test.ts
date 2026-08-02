import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { currentBootId, readEntry, writeEntry } from "./aisdk-registry.ts";
import { addManaged, listManaged, resetManagedRegistryForTests } from "./managed.ts";
import { reconcileCommandFileSessions } from "./session-recovery.ts";
import { managedLaunchRow } from "./sessions.ts";

describe("command-file session boot recovery", () => {
  const originalData = PATHS.data;
  let root: string;
  let capture: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-session-recovery-"));
    capture = join(root, "launch.json");
    PATHS.data = join(root, "data");
    process.env.LFG_TEST_HARNESS_CAPTURE = capture;
    resetManagedRegistryForTests();
  });

  afterEach(() => {
    delete process.env.LFG_TEST_HARNESS_CAPTURE;
    resetManagedRegistryForTests();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("reopens a dead prior-boot SDK harness once without replaying its prompt", async () => {
    const key = "11111111-1111-4111-8111-111111111111";
    const thread = "22222222-2222-4222-8222-222222222222";
    addManaged({
      tmuxName: "lfg-recover-me",
      cwd: root,
      createdAt: 1,
      agent: "codex-aisdk",
      sessionId: key,
      nativeSessionId: thread,
      model: "gpt-5.6-sol",
      launchState: "running",
    });
    writeEntry({
      sessionId: key,
      agent: "codex",
      threadId: thread,
      harnessPid: 2147483647,
      tmuxName: "lfg-recover-me",
      supervisor: "process",
      bootId: "prior-boot",
      cwd: root,
      model: "gpt-5.6-sol",
      busy: true,
      createdAt: 1,
    });

    const result = await reconcileCommandFileSessions(() => {});
    expect(result.bootId).toBe(currentBootId());
    expect(result.recovered).toBe(1);
    const launch = JSON.parse(readFileSync(capture, "utf8")) as { cmd: string[] };
    expect(launch.cmd).not.toContain("tmux");
    expect(launch.cmd.slice(launch.cmd.indexOf("--resume"), launch.cmd.indexOf("--resume") + 2))
      .toEqual(["--resume", thread]);
    expect(launch.cmd).not.toContain("continue");
    expect(readEntry(key)?.recoveryClaimBootId).toBe(currentBootId());
    expect(listManaged()[0]).toEqual(expect.objectContaining({
      interruptedAt: expect.any(Number),
      recoveredFromBootId: "prior-boot",
    }));
  });

  test("does not trust a live-looking PID recorded by a prior boot", async () => {
    const key = "33333333-3333-4333-8333-333333333333";
    addManaged({
      tmuxName: "lfg-reused-pid",
      cwd: root,
      createdAt: 1,
      agent: "aisdk",
      sessionId: key,
      nativeSessionId: key,
      model: "opus",
      launchState: "running",
    });
    writeEntry({
      sessionId: key,
      agent: "claude",
      // Definitely alive, but belongs to this test process/current boot rather
      // than the prior boot recorded below.
      harnessPid: process.pid,
      tmuxName: "lfg-reused-pid",
      supervisor: "process",
      bootId: "prior-boot",
      cwd: root,
      model: "opus",
      busy: false,
      createdAt: 1,
    });

    const result = await reconcileCommandFileSessions(() => {});
    expect(result.adopted).toBe(0);
    expect(result.recovered).toBe(1);
    const launch = JSON.parse(readFileSync(capture, "utf8")) as { cmd: string[] };
    expect(launch.cmd).toContain("--recovered-at");
  });

  test("does not surface a dead registry entry as an already-live managed session", () => {
    const key = "44444444-4444-4444-8444-444444444444";
    const managed = {
      tmuxName: "lfg-dead-entry",
      cwd: root,
      createdAt: 1,
      agent: "codex-aisdk" as const,
      sessionId: key,
      nativeSessionId: "55555555-5555-4555-8555-555555555555",
      model: "gpt-5.6-sol",
      launchState: "running" as const,
    };
    writeEntry({
      sessionId: key,
      agent: "codex",
      harnessPid: 2147483647,
      tmuxName: managed.tmuxName,
      supervisor: "process",
      bootId: currentBootId(),
      cwd: root,
      model: managed.model,
      busy: true,
      createdAt: 1,
    });

    expect(managedLaunchRow(managed, {}, {})).toBeNull();
  });
});
