import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  addManaged,
  getManagedSessionCreation,
  listManaged,
  patchManaged,
  removeManaged,
  resetManagedRegistryForTests,
} from "./managed.ts";

describe("managed session registry", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-managed-registry-"));
    PATHS.data = join(root, "data");
    resetManagedRegistryForTests();
  });

  afterEach(() => {
    resetManagedRegistryForTests();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("rehydrates the in-memory session list after a process restart", () => {
    addManaged({
      tmuxName: "lfg-one",
      cwd: "/tmp/project",
      createdAt: 1,
      agent: "codex-aisdk",
      sessionId: "11111111-1111-4111-8111-111111111111",
      nativeSessionId: "22222222-2222-4222-8222-222222222222",
      launchState: "running",
    });
    patchManaged("lfg-one", { title: "Keep this session" });

    expect(listManaged()).toHaveLength(1);
    resetManagedRegistryForTests(); // equivalent to a fresh serve process

    expect(listManaged()).toEqual([
      expect.objectContaining({
        tmuxName: "lfg-one",
        sessionId: "11111111-1111-4111-8111-111111111111",
        nativeSessionId: "22222222-2222-4222-8222-222222222222",
        title: "Keep this session",
        launchState: "running",
      }),
    ]);
  });

  test("an interrupted temporary write cannot erase the durable roster", () => {
    addManaged({
      tmuxName: "lfg-safe",
      cwd: "/tmp/project",
      createdAt: 1,
      agent: "cursor",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    const registry = join(PATHS.data, "managed-sessions.json");
    writeFileSync(`${registry}.crashed.tmp`, "{");

    resetManagedRegistryForTests();

    expect(JSON.parse(readFileSync(registry, "utf8")).sessions["lfg-safe"].tmuxName).toBe("lfg-safe");
    expect(listManaged().map((row) => row.tmuxName)).toEqual(["lfg-safe"]);
  });

  test("refreshes memory when another process replaces the durable roster", () => {
    addManaged({
      tmuxName: "lfg-old",
      cwd: "/tmp/old",
      createdAt: 1,
      sessionId: "44444444-4444-4444-8444-444444444444",
    });
    const registry = join(PATHS.data, "managed-sessions.json");
    writeFileSync(registry, JSON.stringify({
      "lfg-new": {
        tmuxName: "lfg-new",
        cwd: "/tmp/new-project-with-a-longer-path",
        createdAt: 2,
        sessionId: "55555555-5555-4555-8555-555555555555",
      },
    }));

    expect(listManaged().map((row) => row.tmuxName)).toEqual(["lfg-new"]);
  });

  test("recovers a registry lock left by a crashed process", () => {
    const lock = join(PATHS.data, "managed-sessions.json.lock");
    mkdirSync(PATHS.data, { recursive: true });
    writeFileSync(lock, "2147483647");

    addManaged({
      tmuxName: "lfg-recovered",
      cwd: "/tmp/project",
      createdAt: 3,
      sessionId: "66666666-6666-4666-8666-666666666666",
    });

    expect(listManaged().map((row) => row.tmuxName)).toEqual(["lfg-recovered"]);
  });

  test("a resumed conversation replaces its stale runtime owner", () => {
    const sessionId = "77777777-7777-4777-8777-777777777777";
    addManaged({
      tmuxName: "lfg-old-owner",
      cwd: "/tmp/project",
      createdAt: 1,
      agent: "codex-aisdk",
      sessionId,
      nativeSessionId: "88888888-8888-4888-8888-888888888888",
    });
    addManaged({
      tmuxName: "lfg-new-owner",
      cwd: "/tmp/project",
      createdAt: 2,
      agent: "codex-aisdk",
      sessionId,
      nativeSessionId: "88888888-8888-4888-8888-888888888888",
    });

    expect(listManaged()).toEqual([
      expect.objectContaining({ tmuxName: "lfg-new-owner", sessionId }),
    ]);
  });

  test("atomically replays the first session claimed by an idempotency key", () => {
    const key = "schedule-123:1785920400000";
    const first = addManaged({
      tmuxName: "lfg-first", cwd: "/tmp/project", createdAt: 1, agent: "opencode",
      sessionId: "99999999-9999-4999-8999-999999999999", launchState: "launching",
    }, key);
    const replay = addManaged({
      tmuxName: "lfg-duplicate", cwd: "/tmp/project", createdAt: 2, agent: "opencode",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", launchState: "launching",
    }, key);

    expect(first.created).toBe(true);
    expect(replay).toEqual({
      created: false,
      session: expect.objectContaining({
        tmuxName: "lfg-first",
        sessionId: "99999999-9999-4999-8999-999999999999",
      }),
    });
    expect(listManaged().map((row) => row.tmuxName)).toEqual(["lfg-first"]);
  });

  test("keeps a creation claim after the live managed session is removed", () => {
    const key = "schedule-456:1786006800000";
    addManaged({
      tmuxName: "lfg-finished", cwd: "/tmp/project", createdAt: 1, agent: "pi",
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", launchState: "running",
    }, key);

    removeManaged("lfg-finished");
    resetManagedRegistryForTests();

    expect(listManaged()).toEqual([]);
    expect(getManagedSessionCreation(key)).toEqual(expect.objectContaining({
      tmuxName: "lfg-finished",
      sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }));
  });

  test("forgets a creation claim when the session fails before commit", () => {
    const key = "schedule-789:1786093200000";
    addManaged({
      tmuxName: "lfg-failed", cwd: "/tmp/project", createdAt: 1,
      sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }, key);

    removeManaged("lfg-failed", { forgetCreation: true });

    expect(getManagedSessionCreation(key)).toBeNull();
  });
});
