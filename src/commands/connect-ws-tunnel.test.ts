import { describe, expect, test } from "bun:test";
import {
  applyWsTunnelFrame,
  isWsOpenFrame,
  isWsTunnelFrame,
  openLocalWsTunnel,
  type WsTunnels,
} from "./connect";

/** Minimal EventTarget-ish stand-in for the local `lfg serve` WebSocket. */
class FakeWs {
  readyState = 0; // CONNECTING
  binaryType = "";
  sent: Array<string | Buffer> = [];
  closed = false;
  private listeners: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, event?: any) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  const tunnels: WsTunnels = new Map();
  const out: any[] = [];
  const fake = new FakeWs();
  openLocalWsTunnel(
    { type: "ws-open", id: "t1", path: "/api/live/ws" },
    tunnels,
    (p) => out.push(p),
    () => fake as unknown as WebSocket,
  );
  return { tunnels, out, fake };
}

describe("ws tunnel frame guards", () => {
  test("recognizes a ws-open frame", () => {
    expect(isWsOpenFrame({ type: "ws-open", id: "a", path: "/x" })).toBe(true);
    expect(isWsOpenFrame({ type: "ws-open", id: "a" })).toBe(false);
    expect(isWsOpenFrame({ type: "http", id: "a", path: "/x" })).toBe(false);
  });

  test("recognizes ws-msg / ws-close but not ws-open", () => {
    expect(isWsTunnelFrame({ type: "ws-msg", id: "a" })).toBe(true);
    expect(isWsTunnelFrame({ type: "ws-close", id: "a" })).toBe(true);
    expect(isWsTunnelFrame({ type: "ws-open", id: "a", path: "/x" })).toBe(false);
  });
});

describe("openLocalWsTunnel", () => {
  test("registers the tunnel and acks once the local socket opens", () => {
    const { tunnels, out, fake } = setup();
    expect(tunnels.get("t1")).toBeDefined();
    fake.emit("open");
    expect(out).toEqual([{ type: "ws-ack", id: "t1", ok: true }]);
  });

  test("forwards a text message from the box as base64", () => {
    const { out, fake } = setup();
    fake.emit("open");
    fake.emit("message", { data: "hello" });
    const msg = out.find((f) => f.type === "ws-msg");
    expect(msg.binary).toBe(false);
    expect(Buffer.from(msg.dataB64, "base64").toString("utf8")).toBe("hello");
  });

  test("forwards a binary message and flags it", () => {
    const { out, fake } = setup();
    fake.emit("open");
    fake.emit("message", { data: new Uint8Array([1, 2, 3]).buffer });
    const msg = out.find((f) => f.type === "ws-msg");
    expect(msg.binary).toBe(true);
    expect([...Buffer.from(msg.dataB64, "base64")]).toEqual([1, 2, 3]);
  });

  test("close removes the tunnel and reports it upstream", () => {
    const { tunnels, out, fake } = setup();
    fake.emit("open");
    fake.emit("close", { code: 1006, reason: "gone" });
    expect(tunnels.has("t1")).toBe(false);
    expect(out.some((f) => f.type === "ws-close" && f.code === 1006)).toBe(true);
  });

  test("a failure while still CONNECTING acks the open as failed", () => {
    const { tunnels, out, fake } = setup();
    fake.readyState = 0; // CONNECTING
    fake.emit("error");
    expect(out.some((f) => f.type === "ws-ack" && f.ok === false)).toBe(true);
    expect(tunnels.has("t1")).toBe(false);
  });
});

describe("applyWsTunnelFrame", () => {
  test("delivers a relayed text message to the local socket", () => {
    const { tunnels, fake } = setup();
    applyWsTunnelFrame(
      { type: "ws-msg", id: "t1", dataB64: Buffer.from("ping").toString("base64"), binary: false },
      tunnels,
    );
    expect(fake.sent).toEqual(["ping"]);
  });

  test("delivers binary as a Buffer", () => {
    const { tunnels, fake } = setup();
    applyWsTunnelFrame(
      { type: "ws-msg", id: "t1", dataB64: Buffer.from([9, 8]).toString("base64"), binary: true },
      tunnels,
    );
    expect([...(fake.sent[0] as Buffer)]).toEqual([9, 8]);
  });

  test("ws-close closes and forgets the tunnel", () => {
    const { tunnels, fake } = setup();
    applyWsTunnelFrame({ type: "ws-close", id: "t1" }, tunnels);
    expect(fake.closed).toBe(true);
    expect(tunnels.has("t1")).toBe(false);
  });

  test("an unknown id is ignored, never thrown", () => {
    const { tunnels } = setup();
    expect(() => applyWsTunnelFrame({ type: "ws-msg", id: "nope", dataB64: "" }, tunnels)).not.toThrow();
  });
});
