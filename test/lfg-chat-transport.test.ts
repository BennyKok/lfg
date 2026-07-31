import { afterEach, describe, expect, test } from "bun:test";
import {
  createSameOriginTransport,
} from "../packages/client/src/index.ts";
import {
  LfgChatTransport,
  type LfgTranscriptEvent,
} from "../web/src/lib/lfg-chat-transport.ts";
import { configureLfgTransport } from "../web/src/lib/lfg-client.ts";

afterEach(() => {
  configureLfgTransport(createSameOriginTransport());
});

describe("LfgChatTransport", () => {
  test("sends through the host-configured transport instead of the embedding page origin", async () => {
    const calls: Array<{ path: string; method: string; body: string }> = [];
    configureLfgTransport({
      async fetch(path, init) {
        calls.push({
          path,
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
        });
        return new Response("{}", { status: 200 });
      },
      async request() {
        throw new Error("request should not own the chat transport send");
      },
      async openLiveSocket() {
        throw new Error("socket not used in this test");
      },
    });

    const transport = new LfgChatTransport({
      sessionId: "session-1",
      subscribeTranscript: () => () => {},
    });
    await transport.sendMessages({
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    } as Parameters<LfgChatTransport["sendMessages"]>[0]);

    expect(calls).toEqual([{
      path: "/api/sessions/session-1/send",
      method: "POST",
      body: '{"text":"hello"}',
    }]);
  });

  test("turns repeated reset snapshots into incremental deltas", async () => {
    let listener: ((event: LfgTranscriptEvent) => void) | undefined;
    const transport = new LfgChatTransport({
      sessionId: "session-1",
      fetch: async () => new Response("{}", { status: 200 }),
      subscribeTranscript: (_sid, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });

    const stream = await transport.sendMessages({
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    } as Parameters<LfgChatTransport["sendMessages"]>[0]);
    const chunksPromise = (async () => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return chunks;
    })();

    listener?.({
      type: "ai_part",
      part: { type: "text-delta", id: "draft-1", text: "First", reset: true },
    });
    listener?.({
      type: "ai_part",
      part: { type: "text-delta", id: "draft-1", text: "First response", reset: true },
    });
    listener?.({
      type: "ai_part",
      part: { type: "text-delta", id: "draft-1", text: "First response", reset: true },
    });
    listener?.({ type: "busy", busy: false });

    const chunks = await chunksPromise;
    expect(
      chunks
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => chunk.delta),
    ).toEqual(["First", " response"]);
  });
});
