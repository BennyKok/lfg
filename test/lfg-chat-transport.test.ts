import { afterEach, describe, expect, test } from "bun:test";
import {
  createSameOriginTransport,
} from "../packages/client/src/index.ts";
import {
  LfgChatStreamOwnership,
  LfgChatTransport,
  appendLfgTranscriptEvent,
  type LfgChatMessage,
  type LfgTranscriptEvent,
} from "../web/src/lib/lfg-chat-transport.ts";
import {
  configureLfgTransport,
  openLfgSocket,
} from "../web/src/lib/lfg-client.ts";

afterEach(() => {
  configureLfgTransport(createSameOriginTransport());
});

describe("LfgChatTransport", () => {
  test("claims stream ownership synchronously and scopes overlapping sends by session", async () => {
    const ownership = new LfgChatStreamOwnership();
    let finishFirst!: () => void;
    let finishSecond!: () => void;

    const first = ownership.run("session-1", () => new Promise<void>((resolve) => {
      finishFirst = resolve;
      expect(ownership.owns("session-1")).toBe(true);
    }));
    const second = ownership.run("session-1", () => new Promise<void>((resolve) => {
      finishSecond = resolve;
    }));

    expect(ownership.owns("session-1")).toBe(true);
    expect(ownership.owns("session-2")).toBe(false);
    finishFirst();
    await first;
    expect(ownership.owns("session-1")).toBe(true);
    finishSecond();
    await second;
    expect(ownership.owns("session-1")).toBe(false);
  });

  test("lets the active chat stream exclusively own assistant transcript events", () => {
    const streamed: LfgChatMessage[] = [{
      id: "sdk-generated-message",
      role: "assistant",
      parts: [{ type: "text", text: "One response", state: "done" }],
    }];
    const event: LfgTranscriptEvent = {
      type: "message",
      message: {
        id: "durable-transcript-message",
        role: "assistant",
        kind: "text",
        text: "One response",
        ts: 10,
      },
    };

    // useChat already owns this event through LfgChunkEmitter. The passive
    // transcript listener must not append the durable form alongside it.
    expect(appendLfgTranscriptEvent(streamed, event, { streamActive: true })).toBe(streamed);

    // Externally-driven turns have no useChat stream and still land normally.
    expect(appendLfgTranscriptEvent(streamed, event)).toHaveLength(2);
  });

  test("routes feature sockets through the host-configured transport", async () => {
    const paths: string[] = [];
    const socket = {
      binaryType: "blob" as BinaryType,
      readyState: 0,
      send() {},
      close() {},
      addEventListener() {},
    };
    configureLfgTransport({
      async fetch() {
        return new Response("{}", { status: 200 });
      },
      async request() {
        return {} as never;
      },
      async openSocket(path) {
        paths.push(path);
        return socket;
      },
      async openLiveSocket() {
        throw new Error("live socket not used in this test");
      },
    });

    expect(await openLfgSocket("/api/term?session=main")).toBe(socket);
    expect(paths).toEqual(["/api/term?session=main"]);
  });

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
      async openSocket() {
        throw new Error("socket not used in this test");
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
