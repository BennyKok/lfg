import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  getCachedTranscriptPath,
  pruneResumableExcept,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
} from "./resume-cache.ts";
import { resolveTranscript } from "./sessions.ts";
import { resetTranscriptIndexConnectionForTests } from "./transcript-index.ts";

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-grok-transcript-"));
  PATHS.data = root;
  resetResumeCacheConnectionForTests();
  // resolveTranscript also reaches the transcript index, which keeps its own
  // connection. Without this the suite passed alone and failed in a full run,
  // inheriting whatever PATHS.data an earlier file had bound.
  resetTranscriptIndexConnectionForTests();
});

afterEach(() => {
  resetResumeCacheConnectionForTests();
  resetTranscriptIndexConnectionForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

describe("dual-id Grok transcript after close", () => {
  test("getCachedTranscriptPath resolves LFG id via resume_handle or session_id", () => {
    const omgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const nativeId = "019fcd86-16ec-7f03-b324-6e4162e99728";
    const path = `/tmp/fake-grok/${nativeId}/chat_history.jsonl`;

    upsertResumableRows([
      {
        sessionId: omgId,
        cwd: "/work",
        project: "lfg",
        title: "Closed Grok",
        lastActivityAt: 1_000,
        lastUserText: "hi",
        agent: "grok",
        path,
        mtimeMs: 1_000,
        resumeHandle: nativeId,
        managed: true,
        resumable: true,
      },
      {
        sessionId: nativeId,
        cwd: "/work",
        project: "lfg",
        title: "Closed Grok",
        lastActivityAt: 1_000,
        lastUserText: "hi",
        agent: "grok",
        path,
        mtimeMs: 1_000,
        resumeHandle: nativeId,
        managed: false,
        resumable: true,
      },
    ]);

    expect(getCachedTranscriptPath(omgId)).toBe(path);
    expect(getCachedTranscriptPath(nativeId)).toBe(path);
  });

  test("LFG-id dual-id row survives prune of unmanaged scan set", () => {
    const omgId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const nativeId = "019fcd85-0050-7e60-a086-59cbed975d06";
    const path = `/tmp/fake-grok/${nativeId}/chat_history.jsonl`;

    upsertResumableRows([
      {
        sessionId: omgId,
        cwd: "/work",
        project: "lfg",
        title: "Closed Grok",
        lastActivityAt: 1_000,
        lastUserText: null,
        agent: "grok",
        path,
        mtimeMs: 1_000,
        resumeHandle: nativeId,
        managed: true,
        resumable: true,
      },
      {
        sessionId: nativeId,
        cwd: "/work",
        project: "lfg",
        title: "Closed Grok",
        lastActivityAt: 1_000,
        lastUserText: null,
        agent: "grok",
        path,
        mtimeMs: 1_000,
        resumeHandle: nativeId,
        managed: false,
        resumable: true,
      },
    ]);

    // Scanner only knows the native filesystem id — managed LFG alias must remain.
    pruneResumableExcept(new Set([nativeId]));
    expect(getCachedTranscriptPath(omgId)).toBe(path);
  });

  test("resolveTranscript falls back to resume-cache for a closed dual-id session", async () => {
    const omgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const nativeId = "019fcd6a-c307-7582-ac05-604b51573373";
    const dir = join(root, "grok-session");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "chat_history.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", content: "hello" })}\n`);

    upsertResumableRows([
      {
        sessionId: omgId,
        cwd: root,
        project: "lfg",
        title: "Closed Grok",
        lastActivityAt: Date.now(),
        lastUserText: "hello",
        agent: "grok",
        path,
        mtimeMs: Date.now(),
        resumeHandle: nativeId,
        managed: true,
        resumable: true,
      },
    ]);

    // No managed registry entry, no active Grok process — cache is the only map.
    expect(await resolveTranscript(omgId)).toBe(path);
  });
});
