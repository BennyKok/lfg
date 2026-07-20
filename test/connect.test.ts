import { describe, expect, test } from "bun:test";
import { diffSessionEvents, errorFrameMessage, forwardToLocalServe, isHttpFrame, type SessionLite } from "../src/commands/connect.ts";

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

function session(overrides: Partial<SessionLite> & { sessionId: string }): SessionLite {
  return { busy: false, launching: false, status: "ok", title: "build a todo app", project: "myapp", agent: "claude", ...overrides };
}

describe("diffSessionEvents", () => {
  test("never emits on the first sighting of a session (baseline only)", () => {
    const seen = new Map();
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: true })], 1000);
    expect(events).toEqual([]);
    expect(seen.get("a")).toEqual({ busy: true, status: "ok" });
  });

  test("busy -> idle with ok status emits session.completed", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false })], 2000);
    expect(events).toEqual([
      { type: "event", event: "session.completed", sessionId: "a", title: "build a todo app", project: "myapp", agent: "claude", ts: 2000 },
    ]);
  });

  test("busy -> idle while still launching does not emit (not really done)", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false, launching: true })], 2000);
    expect(events).toEqual([]);
  });

  test("status ok -> blocked emits session.needs_attention", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: true, status: "blocked" })], 3000);
    expect(events).toEqual([
      { type: "event", event: "session.needs_attention", sessionId: "a", title: "build a todo app", project: "myapp", agent: "claude", ts: 3000 },
    ]);
  });

  test("staying blocked across ticks does not re-emit", () => {
    const seen = new Map([["a", { busy: true, status: "blocked" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: true, status: "blocked" })], 4000);
    expect(events).toEqual([]);
  });

  test("blocked -> ok -> blocked again re-emits needs_attention", () => {
    const seen = new Map([["a", { busy: true, status: "blocked" as const }]]);
    let events = diffSessionEvents(seen, [session({ sessionId: "a", busy: true, status: "ok" })], 5000);
    expect(events).toEqual([]);
    events = diffSessionEvents(seen, [session({ sessionId: "a", busy: true, status: "blocked" })], 6000);
    expect(events.map((e) => e.event)).toEqual(["session.needs_attention"]);
  });

  test("staying idle across ticks does not re-emit completed", () => {
    const seen = new Map([["a", { busy: false, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false })], 7000);
    expect(events).toEqual([]);
  });

  test("a session dropping out of the list and reappearing re-baselines instead of comparing stale state", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    // gone this tick
    let events = diffSessionEvents(seen, [], 8000);
    expect(events).toEqual([]);
    expect(seen.has("a")).toBe(false);
    // reappears already idle — no prior baseline, so no event even though it
    // "was" busy two ticks ago
    events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false })], 9000);
    expect(events).toEqual([]);
  });

  test("sessions with no sessionId are ignored", () => {
    const seen = new Map();
    const events = diffSessionEvents(seen, [session({ sessionId: null as unknown as string })], 1000);
    expect(events).toEqual([]);
    expect(seen.size).toBe(0);
  });

  test("multiple sessions are diffed independently in one tick", () => {
    const seen = new Map([
      ["a", { busy: true, status: "ok" as const }],
      ["b", { busy: true, status: "ok" as const }],
    ]);
    const events = diffSessionEvents(
      seen,
      [session({ sessionId: "a", busy: false }), session({ sessionId: "b", busy: true, status: "blocked" })],
      1234,
    );
    expect(events.map((e) => `${e.sessionId}:${e.event}`).sort()).toEqual(["a:session.completed", "b:session.needs_attention"]);
  });

  test("frame fields fall back to null when the session omits title/project/agent", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [{ sessionId: "a", busy: false, status: "ok" }], 1000);
    expect(events).toEqual([
      { type: "event", event: "session.completed", sessionId: "a", title: null, project: null, agent: null, ts: 1000 },
    ]);
  });
});
