import { describe, expect, test } from "bun:test";
import {
  applyStreamCloseFrame,
  isStreamCloseFrame,
  isStreamOpenFrame,
  openLocalStreamTunnel,
  type StreamTunnels,
} from "./connect";

/** A fetch stub whose response body streams the given chunks, then ends. */
function streamingFetch(chunks: string[], opts: { status?: number; failOpen?: boolean } = {}): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (opts.failOpen) throw new Error("connect refused");
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          if (signal?.aborted) break;
          controller.enqueue(new TextEncoder().encode(c));
          await Promise.resolve();
        }
        controller.close();
      },
    });
    return new Response(body, { status: opts.status ?? 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}


describe("stream tunnel frame guards", () => {
  test("recognizes stream-open and stream-close", () => {
    expect(isStreamOpenFrame({ type: "stream-open", id: "a", path: "/api/live/stream" })).toBe(true);
    expect(isStreamOpenFrame({ type: "ws-open", id: "a", path: "/x" })).toBe(false);
    expect(isStreamCloseFrame({ type: "stream-close", id: "a" })).toBe(true);
    expect(isStreamCloseFrame({ type: "stream-data", id: "a" })).toBe(false);
  });
});

describe("openLocalStreamTunnel", () => {
  test("emits head, one data frame per chunk, then close", async () => {
    const out: any[] = [];
    const tunnels: StreamTunnels = new Map();
    openLocalStreamTunnel(
      { type: "stream-open", id: "s1", path: "/api/live/stream" },
      tunnels,
      (p) => out.push(p),
      streamingFetch(["data: a\n\n", "data: b\n\n"]),
    );
    await new Promise((r) => setTimeout(r, 30));
    const types = out.map((f) => f.type);
    expect(types[0]).toBe("stream-head");
    expect(out[0].status).toBe(200);
    const data = out.filter((f) => f.type === "stream-data").map((f) => Buffer.from(f.dataB64, "base64").toString("utf8"));
    expect(data).toEqual(["data: a\n\n", "data: b\n\n"]);
    expect(types.at(-1)).toBe("stream-close");
    expect(tunnels.has("s1")).toBe(false);
  });

  test("a fetch that fails to open reports stream-close with error", async () => {
    const out: any[] = [];
    const tunnels: StreamTunnels = new Map();
    openLocalStreamTunnel(
      { type: "stream-open", id: "s2", path: "/x" },
      tunnels,
      (p) => out.push(p),
      streamingFetch([], { failOpen: true }),
    );
    await new Promise((r) => setTimeout(r, 20));
    const close = out.find((f) => f.type === "stream-close");
    expect(close).toBeDefined();
    expect(close.error).toContain("connect refused");
    expect(tunnels.has("s2")).toBe(false);
  });

  test("applyStreamCloseFrame aborts the fetch and forgets the tunnel", async () => {
    const out: any[] = [];
    const tunnels: StreamTunnels = new Map();
    // A never-ending stream so we can abort it mid-flight.
    const foreverFetch = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 1000 && !signal?.aborted; i++) {
            controller.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
            await new Promise((r) => setTimeout(r, 5));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    openLocalStreamTunnel({ type: "stream-open", id: "s3", path: "/x" }, tunnels, (p) => out.push(p), foreverFetch);
    await new Promise((r) => setTimeout(r, 15));
    expect(tunnels.has("s3")).toBe(true);
    applyStreamCloseFrame({ id: "s3" }, tunnels);
    expect(tunnels.has("s3")).toBe(false);
    await new Promise((r) => setTimeout(r, 15));
    // An abort is clean teardown — the terminal close carries no error.
    const close = out.filter((f) => f.type === "stream-close").at(-1);
    expect(close.error).toBeUndefined();
  });

  test("an unknown stream-close id is a no-op", () => {
    const tunnels: StreamTunnels = new Map();
    expect(() => applyStreamCloseFrame({ id: "ghost" }, tunnels)).not.toThrow();
  });
});
