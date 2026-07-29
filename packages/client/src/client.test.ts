import { expect, test } from "bun:test";
import { LfgLiveConnection, type LfgSocket, type LfgTransport } from "./index";

class FakeSocket implements LfgSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event?: never) => void>>();

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: never) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  open() {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener();
  }
}

test("many transcript subscriptions share one socket and one batched subscribe frame", async () => {
  const socket = new FakeSocket();
  let opens = 0;
  const transport: LfgTransport = {
    request: async () => ({}) as never,
    openLiveSocket: async () => {
      opens += 1;
      return socket;
    },
  };
  const live = new LfgLiveConnection(transport);
  const offA = live.subscribeTranscript("a", () => {});
  const offB = live.subscribeTranscript("b", () => {});
  await Promise.resolve();
  socket.open();
  await Promise.resolve();

  expect(opens).toBe(1);
  expect(socket.sent).toHaveLength(1);
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    t: "subscribe",
    channels: [
      { kind: "transcript", key: "a" },
      { kind: "transcript", key: "b" },
    ],
  });

  offA();
  offB();
  live.dispose();
});
