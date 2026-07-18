import { describe, expect, test } from "bun:test";
import { errorFrameMessage, forwardToLocalServe, isHttpFrame } from "../src/commands/connect.ts";

describe("isHttpFrame", () => {
  test("accepts a well-formed http frame", () => {
    expect(isHttpFrame({ type: "http", id: "1", method: "GET", path: "/api/sessions" })).toBe(true);
  });

  test("rejects frames missing required fields or of a different type", () => {
    expect(isHttpFrame({ type: "ping" })).toBe(false);
    expect(isHttpFrame({ type: "http", id: "1", method: "GET" })).toBe(false); // no path
    expect(isHttpFrame(null)).toBe(false);
    expect(isHttpFrame("http")).toBe(false);
  });
});

describe("errorFrameMessage", () => {
  test("extracts the message from a well-formed error frame", () => {
    expect(errorFrameMessage({ type: "error", message: "pairing code invalid or expired" })).toBe(
      "pairing code invalid or expired",
    );
  });

  test("falls back to a generic message when the frame omits one", () => {
    expect(errorFrameMessage({ type: "error" })).toBe("the relay rejected this connection");
  });

  test("returns null for anything that isn't an error frame", () => {
    expect(errorFrameMessage({ type: "paired", token: "x", boxId: "y" })).toBeNull();
    expect(errorFrameMessage({ type: "ping" })).toBeNull();
    expect(errorFrameMessage(null)).toBeNull();
    expect(errorFrameMessage("error")).toBeNull();
  });
});

describe("forwardToLocalServe", () => {
  test("forwards method/path/body to local serve and base64-encodes the response", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ sessionId: "abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const response = await forwardToLocalServe({
        type: "http",
        id: "req-1",
        method: "POST",
        path: "/api/sessions/new",
        headers: { "content-type": "application/json" },
        bodyB64: Buffer.from(JSON.stringify({ prompt: "hi" })).toString("base64"),
      });
      expect(seenUrl).toContain("/api/sessions/new");
      expect(seenInit?.method).toBe("POST");
      expect(Buffer.from(String(seenInit?.body)).toString("utf8")).toBe(JSON.stringify({ prompt: "hi" }));
      expect(response.id).toBe("req-1");
      expect(response.status).toBe(200);
      expect(Buffer.from(response.bodyB64, "base64").toString("utf8")).toBe(JSON.stringify({ sessionId: "abc" }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("answers 502 (not a thrown error) when local serve is unreachable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    try {
      const response = await forwardToLocalServe({ type: "http", id: "req-2", method: "GET", path: "/api/sessions" });
      expect(response.status).toBe(502);
      expect(Buffer.from(response.bodyB64, "base64").toString("utf8")).toContain("connection refused");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
