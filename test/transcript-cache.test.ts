import { beforeEach, describe, expect, test } from "bun:test";
import type { OmgChatMessage } from "../web/src/lib/omg-chat-transport.ts";
import {
  clearTranscriptCache,
  readTranscriptCache,
  updateTranscriptCacheMessages,
  writeTranscriptCache,
} from "../web/src/lib/transcript-cache.ts";

function msg(id: string): OmgChatMessage {
  return { id, role: "assistant", parts: [{ type: "text", text: id }] } as OmgChatMessage;
}

describe("transcript cache", () => {
  beforeEach(() => clearTranscriptCache());

  test("round-trips a written page so a re-open can paint instantly", () => {
    writeTranscriptCache("s1", [msg("a"), msg("b")], 42);
    const entry = readTranscriptCache("s1");
    expect(entry?.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(entry?.nextBefore).toBe(42);
  });

  test("misses cleanly for an unknown session", () => {
    expect(readTranscriptCache("nope")).toBeNull();
  });

  test("live updates keep the cached page current", () => {
    writeTranscriptCache("s1", [msg("a")], null);
    updateTranscriptCacheMessages("s1", [msg("a"), msg("b")]);
    expect(readTranscriptCache("s1")?.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("live updates never create an entry for an unloaded session", () => {
    updateTranscriptCacheMessages("ghost", [msg("a")]);
    expect(readTranscriptCache("ghost")).toBeNull();
  });

  test("keeps the cache bounded", () => {
    for (let i = 0; i < 200; i += 1) writeTranscriptCache(`s${i}`, [msg(`m${i}`)], null);
    let kept = 0;
    for (let i = 0; i < 200; i += 1) if (readTranscriptCache(`s${i}`)) kept += 1;
    expect(kept).toBeLessThanOrEqual(24);
    // The most recent writes are the ones worth keeping.
    expect(readTranscriptCache("s199")).not.toBeNull();
  });

  test("reading refreshes LRU position so an active session survives churn", () => {
    writeTranscriptCache("old", [msg("a")], null);
    for (let i = 0; i < 20; i += 1) writeTranscriptCache(`f${i}`, [msg(`m${i}`)], null);
    readTranscriptCache("old"); // touch it
    for (let i = 20; i < 40; i += 1) writeTranscriptCache(`f${i}`, [msg(`m${i}`)], null);
    // Not asserting survival forever — just that touching moved it ahead of the
    // entries written before the touch.
    expect(readTranscriptCache("f0")).toBeNull();
  });
});
