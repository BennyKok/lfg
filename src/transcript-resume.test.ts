import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  indexedMessagePage,
  prepareFileHistoryForResume,
  resetTranscriptIndexConnectionForTests,
  sessionIndexKey,
} from "./transcript-index.ts";

const SOURCE_SESSION = "11111111-1111-4111-8111-111111111111";
const TARGET_SESSION = "22222222-2222-4222-8222-222222222222";

describe("file-backed session resume history", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-transcript-resume-"));
    PATHS.data = join(root, "data");
    resetTranscriptIndexConnectionForTests();
  });

  afterEach(() => {
    resetTranscriptIndexConnectionForTests();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("cold Codex rollout is imported before seeding the resumed session key", async () => {
    const transcript = join(root, `rollout-${SOURCE_SESSION}.jsonl`);
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          timestamp: "2026-07-28T07:00:00.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Please continue this work" },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T07:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I have the prior context." }],
          },
        }),
        "",
      ].join("\n"),
    );

    expect(
      await prepareFileHistoryForResume(transcript, SOURCE_SESSION, TARGET_SESSION),
    ).toBeGreaterThan(0);

    const page = await indexedMessagePage(sessionIndexKey(TARGET_SESSION), TARGET_SESSION);
    expect(page.messages.some(
      ({ role, text }) => role === "user" && text === "Please continue this work",
    )).toBe(true);
    expect(page.messages.some(
      ({ role, text }) => role === "assistant" && text === "I have the prior context.",
    )).toBe(true);
  });

  test("cold Claude transcript is imported before resuming under the same id", async () => {
    const transcript = join(root, `${SOURCE_SESSION}.jsonl`);
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-one",
          timestamp: "2026-07-28T07:00:00.000Z",
          message: { role: "user", content: "Keep my Claude history" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-one",
          timestamp: "2026-07-28T07:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "History retained." }],
          },
        }),
        "",
      ].join("\n"),
    );

    expect(
      await prepareFileHistoryForResume(transcript, SOURCE_SESSION, SOURCE_SESSION),
    ).toBeGreaterThan(0);

    const page = await indexedMessagePage(sessionIndexKey(SOURCE_SESSION), SOURCE_SESSION);
    expect(page.messages.some(({ text }) => text === "Keep my Claude history")).toBe(true);
    expect(page.messages.some(({ text }) => text === "History retained.")).toBe(true);
  });
});
