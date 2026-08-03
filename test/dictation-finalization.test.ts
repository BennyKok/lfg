import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { openSttStream } from "../src/voice-providers";

const OriginalWebSocket = globalThis.WebSocket;
const originalElevenLabsKey = process.env.ELEVENLABS_API_KEY;
const originalCommitStrategy = process.env.ELEVENLABS_STT_COMMIT_STRATEGY;

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
  if (originalElevenLabsKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = originalElevenLabsKey;
  if (originalCommitStrategy === undefined)
    delete process.env.ELEVENLABS_STT_COMMIT_STRATEGY;
  else process.env.ELEVENLABS_STT_COMMIT_STRATEGY = originalCommitStrategy;
});

describe("dictation finalization", () => {
  test("keeps the stopping session attached until its realtime final arrives", async () => {
    const app = await readFile("web/src/App.tsx", "utf8");
    const stopBlock = app.slice(app.indexOf("const stop = useCallback"), app.indexOf("const start = useCallback"));

    expect(stopBlock).toContain("if (s.stopping) return");
    expect(stopBlock).toContain("s.stopping = true");
    expect(stopBlock).toContain("if (sessionRef.current === s) sessionRef.current = null");
    expect(stopBlock.indexOf("s.stopping = true")).toBeLessThan(
      stopBlock.indexOf('s.ws.send(JSON.stringify({ type: "flush" }))'),
    );
    expect(stopBlock.indexOf("sessionRef.current = null")).toBeGreaterThan(
      stopBlock.indexOf("s.stopping = true"),
    );
    expect(stopBlock).toContain("const needsFinal = !s.committed || !!s.partial");
  });

  test("uses one manual commit for a take even when close follows flush", () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket {
      sent: string[] = [];
      listeners = new Map<string, Array<(event: unknown) => void>>();
      url: string;

      constructor(url: string | URL) {
        this.url = String(url);
        sockets.push(this);
      }

      addEventListener(type: string, listener: (event: unknown) => void) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      emit(type: string, event: unknown = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      send(message: string) {
        this.sent.push(message);
      }

      close() {}
    }

    process.env.ELEVENLABS_API_KEY = "test-key";
    delete process.env.ELEVENLABS_STT_COMMIT_STRATEGY;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const bridge = openSttStream({ onPartial() {}, onFinal() {} });
    expect(bridge).not.toBeNull();
    const socket = sockets[0];
    expect(socket.url).not.toContain("commit_strategy=vad");
    socket.emit("open");

    // A full 100ms frame drains upstream without a commit. flush() then sends
    // the one empty commit boundary; close() must not send a second one.
    bridge!.pushPcm(new Uint8Array(3200));
    bridge!.flush();
    bridge!.close();

    const messages = socket.sent.map((message) => JSON.parse(message) as { commit: boolean });
    expect(messages.map((message) => message.commit)).toEqual([false, true]);
  });
});
