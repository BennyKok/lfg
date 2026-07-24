import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  queryHistoricalCache,
  queryResumableCache,
  resetResumeCacheConnectionForTests,
  upsertResumableRows,
} from "./resume-cache.ts";

const originalData = PATHS.data;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lfg-historical-cache-"));
  PATHS.data = root;
  resetResumeCacheConnectionForTests();
});

afterEach(() => {
  resetResumeCacheConnectionForTests();
  PATHS.data = originalData;
  rmSync(root, { recursive: true, force: true });
});

describe("historical session cache", () => {
  test("filters by id prefix, user, project/cwd, and activity range", () => {
    upsertResumableRows([
      {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        cwd: "/home/dev/repos/lfg",
        project: "lfg",
        title: "Historical finder",
        lastActivityAt: 2_000,
        lastUserText: "find the old session",
        agent: "claude",
        path: "/tmp/a.jsonl",
        mtimeMs: 2_000,
        assignedUser: "dev@example.com",
      },
      {
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        cwd: "/home/dev/repos/other",
        project: "other",
        title: "Other work",
        lastActivityAt: 4_000,
        lastUserText: null,
        agent: "grok",
        path: "/tmp/b.jsonl",
        mtimeMs: 4_000,
        assignedUser: "other@example.com",
        resumable: false,
      },
    ]);

    expect(queryHistoricalCache({
      sessionId: "aaaa",
      user: "DEV@example.com",
      project: "repos/lfg",
      activeAfter: 1_500,
      activeBefore: 2_500,
    })).toMatchObject({
      total: 1,
      truncated: false,
      sessions: [{
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        transcriptPath: "/tmp/a.jsonl",
        agent: "claude",
        assignedUser: "dev@example.com",
      }],
    });
  });

  test("keeps discoverable-only agents out of the resume picker", () => {
    upsertResumableRows([
      {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        cwd: "/home/dev/repos/lfg",
        project: "lfg",
        title: "Claude session",
        lastActivityAt: 2_000,
        lastUserText: null,
        agent: "claude",
        path: "/tmp/a.jsonl",
        mtimeMs: 2_000,
      },
      {
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        cwd: "/home/dev/repos/lfg",
        project: "lfg",
        title: "Cursor session",
        lastActivityAt: 3_000,
        lastUserText: null,
        agent: "cursor",
        path: "/tmp/b.jsonl",
        mtimeMs: 3_000,
        resumable: false,
      },
    ]);

    expect(queryHistoricalCache().sessions.map((session) => session.agent)).toEqual([
      "cursor",
      "claude",
    ]);
    expect(queryResumableCache().sessions.map((session) => session.agent)).toEqual([
      "claude",
    ]);
  });
});
