import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import type { SessionMsg } from "./sessions.ts";
import {
  indexedMessagePage,
  indexSessionMessagesDirect,
  resetTranscriptIndexConnectionForTests,
  sessionIndexKey,
} from "./transcript-index.ts";

const SESSION = "55555555-5555-4555-8555-555555555555";

describe("conversation transcript pages", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-conversation-page-"));
    PATHS.data = join(root, "data");
    resetTranscriptIndexConnectionForTests();
  });

  afterEach(() => {
    resetTranscriptIndexConnectionForTests();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("tool-heavy tails cannot push chat messages out of the initial page", async () => {
    const messages: SessionMsg[] = [
      { id: "user-1", role: "user", kind: "text", text: "Start the migration", ts: 1 },
      { id: "assistant-1", role: "assistant", kind: "text", text: "I am on it.", ts: 2 },
      ...Array.from({ length: 100 }, (_, index): SessionMsg => ({
        id: `tool-${index}`,
        role: "assistant",
        kind: index % 2 === 0 ? "tool_use" : "tool_result",
        text: index % 2 === 0 ? `exec_command: ${"x".repeat(2_000)}` : "command output",
        ts: 3 + index,
      })),
      { id: "assistant-2", role: "assistant", kind: "text", text: "Still working.", ts: 103 },
    ];
    indexSessionMessagesDirect(SESSION, messages);

    const raw = await indexedMessagePage(sessionIndexKey(SESSION), SESSION, { limit: 80 });
    expect(raw.messages.every((message) => message.kind === "tool_use" || message.kind === "tool_result" || message.id === "assistant-2")).toBe(true);

    const page = await indexedMessagePage(sessionIndexKey(SESSION), SESSION, {
      limit: 2,
      conversationOnly: true,
    });
    expect(page.total).toBe(3);
    expect(page.messages.map((message) => message.id)).toEqual(["assistant-1", "assistant-2"]);
    expect(page.messages.every((message) => !message.text.includes("x".repeat(100)))).toBe(true);

    const older = await indexedMessagePage(sessionIndexKey(SESSION), SESSION, {
      before: page.nextBefore,
      limit: 2,
      conversationOnly: true,
    });
    expect(older.messages.map((message) => message.id)).toEqual(["user-1"]);
    expect(older.nextBefore).toBeNull();
  });
});
