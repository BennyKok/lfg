import { afterEach, describe, expect, test } from "bun:test";
import {
  createSameOriginTransport,
} from "../packages/client/src/index.ts";
import {
  OmgChatStreamOwnership,
  OmgChatTransport,
  appendOmgTranscriptEvent,
  type OmgChatMessage,
  type OmgTranscriptEvent,
} from "../web/src/lib/omg-chat-transport.ts";
import {
  configureOmgTransport,
  openOmgSocket,
} from "../web/src/lib/omg-client.ts";

afterEach(() => {
  configureOmgTransport(createSameOriginTransport());
});

describe("OmgChatTransport", () => {
  test("claims stream ownership synchronously and scopes overlapping sends by session", async () => {
    const ownership = new OmgChatStreamOwnership();
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
    const streamed: OmgChatMessage[] = [{
      id: "sdk-generated-message",
      role: "assistant",
      parts: [{ type: "text", text: "One response", state: "done" }],
    }];
    const event: OmgTranscriptEvent = {
      type: "message",
      message: {
        id: "durable-transcript-message",
        role: "assistant",
        kind: "text",
        text: "One response",
        ts: 10,
      },
    };

    // useChat already owns this event through OmgChunkEmitter. The passive
    // transcript listener must not append the durable form alongside it.
    expect(appendOmgTranscriptEvent(streamed, event, { streamActive: true })).toBe(streamed);

    // Externally-driven turns have no useChat stream and still land normally.
    expect(appendOmgTranscriptEvent(streamed, event)).toHaveLength(2);
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
    configureOmgTransport({
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

    expect(await openOmgSocket("/api/term?session=main")).toBe(socket);
    expect(paths).toEqual(["/api/term?session=main"]);
  });

  test("sends through the host-configured transport instead of the embedding page origin", async () => {
    const calls: Array<{ path: string; method: string; body: string }> = [];
    configureOmgTransport({
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

    const transport = new OmgChatTransport({
      sessionId: "session-1",
      subscribeTranscript: () => () => {},
    });
    await transport.sendMessages({
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
    } as Parameters<OmgChatTransport["sendMessages"]>[0]);

    expect(calls).toEqual([{
      path: "/api/sessions/session-1/send",
      method: "POST",
      body: '{"text":"hello"}',
    }]);
  });

  test("turns repeated reset snapshots into incremental deltas", async () => {
    let listener: ((event: OmgTranscriptEvent) => void) | undefined;
    const transport = new OmgChatTransport({
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
    } as Parameters<OmgChatTransport["sendMessages"]>[0]);
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
