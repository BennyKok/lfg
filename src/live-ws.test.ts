import { afterEach, describe, expect, test } from "bun:test";
import { liveTransportMode } from "./live-ws.ts";

const original = process.env.LIVE_TRANSPORT;

afterEach(() => {
  if (original === undefined) delete process.env.LIVE_TRANSPORT;
  else process.env.LIVE_TRANSPORT = original;
});

describe("liveTransportMode", () => {
  test("defaults to WebSocket transcripts", () => {
    delete process.env.LIVE_TRANSPORT;
    expect(liveTransportMode()).toBe("ws");
  });

  test("allows an explicit SSE compatibility override", () => {
    process.env.LIVE_TRANSPORT = "sse";
    expect(liveTransportMode()).toBe("sse");
  });
});
