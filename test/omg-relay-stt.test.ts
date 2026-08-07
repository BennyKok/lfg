// The omg relay provider: on a hosted workspace there is no local STT key, so
// dictation streams through the platform's per-sandbox media proxy instead of
// silently degrading to the after-the-fact batch path.
import { afterEach, beforeEach, expect, test } from "bun:test";

type Listener = (ev: { data?: unknown; message?: string }) => void;

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  url: string;
  binaryType = "";
  sent: Array<string | Uint8Array> = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  addEventListener(type: string, fn: Listener) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type: string, ev: { data?: unknown; message?: string } = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  send(frame: string | Uint8Array) {
    this.sent.push(frame);
  }
  close() {
    this.closed = true;
  }
}

const realWebSocket = globalThis.WebSocket;
const realMediaURL = process.env.OMG_MEDIA_URL;
const realElevenKey = process.env.ELEVENLABS_API_KEY;

beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  FakeWebSocket.last = null;
  process.env.OMG_MEDIA_URL = "http://172.20.3.1:9090/media";
  delete process.env.ELEVENLABS_API_KEY;
});

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  if (realMediaURL === undefined) delete process.env.OMG_MEDIA_URL;
  else process.env.OMG_MEDIA_URL = realMediaURL;
  if (realElevenKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = realElevenKey;
});

test("a hosted workspace with no local key streams through the omg relay", async () => {
  const { openSttStream, sttStreamingAvailable } = await import("../src/voice-providers.ts");

  expect(sttStreamingAvailable()).toBe(true);

  const partials: string[] = [];
  const finals: string[] = [];
  const bridge = openSttStream({
    onPartial: (t) => partials.push(t),
    onFinal: (t) => finals.push(t),
  });
  expect(bridge).not.toBeNull();

  const ws = FakeWebSocket.last!;
  // http:// → ws://, and the relay path is appended to OMG_MEDIA_URL.
  expect(ws.url).toBe("ws://172.20.3.1:9090/media/realtime/transcribe");

  // Audio pushed before the socket opens must be queued, not dropped.
  bridge!.pushPcm(new Uint8Array(3200));
  expect(ws.sent.length).toBe(0);
  ws.emit("open");
  expect(ws.sent.length).toBe(1);
  expect((ws.sent[0] as Uint8Array).length).toBe(3200);

  // Interim and committed transcripts reach the handlers.
  ws.emit("message", { data: JSON.stringify({ type: "partial", text: "hello wor" }) });
  ws.emit("message", { data: JSON.stringify({ type: "final", text: "hello world" }) });
  expect(partials).toEqual(["hello wor"]);
  expect(finals).toEqual(["hello world"]);

  // flush marks the utterance boundary; close says goodbye before hanging up.
  bridge!.flush();
  expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "flush" }));
  bridge!.close();
  expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "eof" }));
  expect(ws.closed).toBe(true);
});

test("the relay bridge copies each PCM frame", async () => {
  const { openSttStream } = await import("../src/voice-providers.ts");
  const bridge = openSttStream({ onPartial: () => {}, onFinal: () => {} })!;
  const ws = FakeWebSocket.last!;
  ws.emit("open");

  // Bun reuses the read buffer between frames, so a retained reference would be
  // silently rewritten with the NEXT frame's audio.
  const frame = new Uint8Array([1, 2, 3, 4]);
  bridge.pushPcm(frame);
  frame.fill(9);
  expect(Array.from(ws.sent[0] as Uint8Array)).toEqual([1, 2, 3, 4]);
});

test("a stale saved provider does not pin a hosted workspace to a keyless one", async () => {
  const { openSttStream } = await import("../src/voice-providers.ts");
  // data/voice-settings.json in this repo says "elevenlabs", and no key is set
  // here — the resolver must fall through to the relay rather than returning
  // null (which is what made every take batch-only).
  const bridge = openSttStream({ onPartial: () => {}, onFinal: () => {} });
  expect(bridge).not.toBeNull();
  expect(FakeWebSocket.last!.url).toContain("/realtime/transcribe");
});

test("the relay reports batch transcription as unavailable rather than empty", async () => {
  const { transcribeStt } = await import("../src/voice-providers.ts");
  const res = await transcribeStt(new ArrayBuffer(8));
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toContain("realtime-only");
});

test("without OMG_MEDIA_URL the relay is not offered", async () => {
  delete process.env.OMG_MEDIA_URL;
  const { sttStreamingAvailable, listProviders } = await import("../src/voice-providers.ts");
  expect(sttStreamingAvailable()).toBe(false);
  const omg = listProviders().stt.find((p) => p.id === "omg");
  expect(omg?.available).toBe(false);
  expect(omg?.streaming).toBe(true);
});
