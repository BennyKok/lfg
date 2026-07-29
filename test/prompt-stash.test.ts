import { beforeEach, describe, expect, test } from "bun:test";
import {
  PROMPT_STASH_STORAGE_KEY,
  clearPromptStash,
  readPromptDraft,
  readPromptStash,
  removePromptStash,
  setPromptStashStatus,
  stagePromptSend,
  stashPromptDraft,
} from "../web/src/lib/prompt-stash.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("prompt stash", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  test("updates one live draft per composer context", () => {
    const first = stashPromptDraft(
      { contextKey: "session:a", source: "session", sessionId: "a", text: "hel" },
      storage,
    );
    const updated = stashPromptDraft(
      { contextKey: "session:a", source: "session", sessionId: "a", text: "hello" },
      storage,
    );

    expect(updated?.id).toBe(first?.id);
    expect(readPromptStash(storage)).toHaveLength(1);
    expect(readPromptDraft("session:a", storage)?.text).toBe("hello");
  });

  test("turns a draft into retained send history and starts a fresh next draft", () => {
    const draft = stashPromptDraft(
      { contextKey: "new-session", source: "new-session", text: "build it" },
      storage,
    );
    const sending = stagePromptSend(
      { contextKey: "new-session", source: "new-session", text: "build it" },
      storage,
    );
    setPromptStashStatus(sending?.id, "sent", storage);
    const next = stashPromptDraft(
      { contextKey: "new-session", source: "new-session", text: "one more thing" },
      storage,
    );

    expect(sending?.id).toBe(draft?.id);
    expect(next?.id).not.toBe(sending?.id);
    expect(readPromptStash(storage).map((entry) => entry.status).sort()).toEqual([
      "draft",
      "sent",
    ]);
  });

  test("failed sends can return to a recoverable draft", () => {
    const sending = stagePromptSend(
      { contextKey: "session:a", source: "session", sessionId: "a", text: "don't lose me" },
      storage,
    );
    setPromptStashStatus(sending?.id, "draft", storage);

    expect(readPromptDraft("session:a", storage)?.text).toBe("don't lose me");
  });

  test("empty text removes only the active draft, not sent history", () => {
    const sent = stagePromptSend(
      { contextKey: "new-session", source: "new-session", text: "already sent" },
      storage,
    );
    setPromptStashStatus(sent?.id, "sent", storage);
    stashPromptDraft(
      { contextKey: "new-session", source: "new-session", text: "unfinished" },
      storage,
    );
    stashPromptDraft(
      { contextKey: "new-session", source: "new-session", text: "   " },
      storage,
    );

    expect(readPromptStash(storage)).toHaveLength(1);
    expect(readPromptStash(storage)[0].status).toBe("sent");
  });

  test("ignores malformed storage and supports remove and clear", () => {
    storage.setItem(PROMPT_STASH_STORAGE_KEY, "{not json");
    expect(readPromptStash(storage)).toEqual([]);

    const entry = stashPromptDraft(
      { contextKey: "new-session", source: "new-session", text: "draft" },
      storage,
    );
    removePromptStash(entry!.id, storage);
    expect(readPromptStash(storage)).toEqual([]);

    stashPromptDraft(
      { contextKey: "new-session", source: "new-session", text: "again" },
      storage,
    );
    clearPromptStash(storage);
    expect(readPromptStash(storage)).toEqual([]);
  });
});
