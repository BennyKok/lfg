import { describe, expect, test } from "bun:test";
import {
  diffAskEvents,
  diffAutoFindingEvents,
  diffSessionEvents,
  diffShipEvents,
  errorFrameMessage,
  forwardToLocalServe,
  isHttpFrame,
  isReportableTransition,
  isTopLevelSession,
  normalizeComputerUrl,
  streamToLocalServe,
  applyWsTunnelFrame,
  type SessionLite,
} from "../src/commands/connect.ts";
import { decodeBinaryFrame, encodeBinaryFrame, negotiateCaps } from "../src/relay-frames.ts";

describe("normalizeComputerUrl", () => {
  test("canonicalizes the explicit outer URL advertised during connect", () => {
    expect(normalizeComputerUrl(" https://macbook.example/lfg/ ")).toBe("https://macbook.example/lfg");
  });

  test("rejects local paths, credentials, and non-http schemes", () => {
    expect(() => normalizeComputerUrl("file:///tmp/lfg")).toThrow("absolute http(s) URL");
    expect(() => normalizeComputerUrl("https://user:secret@macbook.example")).toThrow("absolute http(s) URL");
  });
});

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

  test("a subagent's completion (parentSessionId set) never emits — subagent churn stays on the box", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(
      seen,
      [session({ sessionId: "a", busy: false, parentSessionId: "parent-1", startedAt: 0 })],
      120_000,
    );
    expect(events).toEqual([]);
  });

  test("a subagent's needs_attention never emits either — top-level filter applies to both kinds", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(
      seen,
      [session({ sessionId: "a", busy: true, status: "blocked", parentSessionId: "parent-1" })],
      1000,
    );
    expect(events).toEqual([]);
  });

  test("a top-level completion under the 60s duration floor is dropped", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false, startedAt: 0 })], 30_000);
    expect(events).toEqual([]);
  });

  test("a top-level completion at/over the 60s duration floor is reported", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false, startedAt: 0 })], 60_000);
    expect(events.map((e) => e.event)).toEqual(["session.completed"]);
  });

  test("needs_attention is exempt from the duration floor — reported even for a brand-new session", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(
      seen,
      [session({ sessionId: "a", busy: true, status: "blocked", startedAt: 0 })],
      1_000,
    );
    expect(events.map((e) => e.event)).toEqual(["session.needs_attention"]);
  });

  test("a completion with no startedAt to judge is reported rather than silently dropped", () => {
    const seen = new Map([["a", { busy: true, status: "ok" as const }]]);
    const events = diffSessionEvents(seen, [session({ sessionId: "a", busy: false, startedAt: undefined })], 1_000);
    expect(events.map((e) => e.event)).toEqual(["session.completed"]);
  });
});

describe("isTopLevelSession", () => {
  test("a session with no parentSessionId and no subagentDepth is top-level", () => {
    expect(isTopLevelSession(session({ sessionId: "a" }))).toBe(true);
  });

  test("a session with a parentSessionId is not top-level", () => {
    expect(isTopLevelSession(session({ sessionId: "a", parentSessionId: "parent-1" }))).toBe(false);
  });

  test("a session with a positive subagentDepth is not top-level, even with no parentSessionId", () => {
    expect(isTopLevelSession(session({ sessionId: "a", subagentDepth: 2 }))).toBe(false);
  });

  test("subagentDepth 0/null is treated the same as absent — top-level", () => {
    expect(isTopLevelSession(session({ sessionId: "a", subagentDepth: 0 }))).toBe(true);
    expect(isTopLevelSession(session({ sessionId: "a", subagentDepth: null }))).toBe(true);
  });
});

describe("isReportableTransition", () => {
  test("a subagent is never reportable, regardless of event kind or duration", () => {
    const sub = session({ sessionId: "a", parentSessionId: "parent-1", startedAt: 0 });
    expect(isReportableTransition("session.completed", sub, 1_000_000)).toBe(false);
    expect(isReportableTransition("session.needs_attention", sub, 1_000_000)).toBe(false);
  });

  test("a top-level completion under 60s is not reportable", () => {
    expect(isReportableTransition("session.completed", session({ sessionId: "a", startedAt: 0 }), 59_999)).toBe(
      false,
    );
  });

  test("a top-level completion at exactly 60s is reportable", () => {
    expect(isReportableTransition("session.completed", session({ sessionId: "a", startedAt: 0 }), 60_000)).toBe(
      true,
    );
  });

  test("a top-level needs_attention is reportable regardless of duration", () => {
    expect(
      isReportableTransition("session.needs_attention", session({ sessionId: "a", startedAt: 0 }), 1),
    ).toBe(true);
  });
});

describe("diffShipEvents", () => {
  const post = (over: Partial<import("../src/commands/connect").ShipPostLite>) => ({
    id: "p1",
    rev: 1,
    ts: 1000,
    title: "dark mode",
    ...over,
  });

  test("first poll only seeds the baseline — never replays the feed", () => {
    const seen = new Map<string, number>();
    const events = diffShipEvents(seen, [post({}), post({ id: "p2" })], true);
    expect(events).toEqual([]);
    expect(seen.get("p1")).toBe(1);
    expect(seen.get("p2")).toBe(1);
  });

  test("a new ship after seeding is forwarded with summary + ship-shaped fallback sessionId", () => {
    const seen = new Map<string, number>([["p1", 1]]);
    const events = diffShipEvents(seen, [post({}), post({ id: "p2", summary: "now with themes" })], false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "ship.posted",
      sessionId: "ship:p2",
      title: "dark mode",
      summary: "now with themes",
    });
  });

  test("a higher rev on a known id re-forwards; same rev stays silent", () => {
    const seen = new Map<string, number>([["p1", 1]]);
    expect(diffShipEvents(seen, [post({ rev: 2 })], false)).toHaveLength(1);
    expect(diffShipEvents(seen, [post({ rev: 2 })], false)).toEqual([]);
  });

  test("a ship with a real sessionId keeps it", () => {
    const seen = new Map<string, number>();
    seen.set("seed", 1);
    const events = diffShipEvents(seen, [post({ sessionId: "sess-9" })], false);
    expect(events[0]!.sessionId).toBe("sess-9");
  });
});

describe("diffAutoFindingEvents", () => {
  const finding = (over: Partial<import("../src/commands/connect").AutoFindingLite>) => ({
    id: "f1",
    agentId: "inbox-triage",
    title: "3 stale PRs are blocking the release branch",
    reasoning: ["PR #12 has been open 9 days", "PR #14 conflicts with main"],
    suggest: "rebase #14 first",
    severity: "med" as const,
    createdAt: 1000,
    status: "open",
    ...over,
  });

  test("first poll only seeds the baseline — never replays the open backlog", () => {
    const seen = new Set<string>();
    const events = diffAutoFindingEvents(seen, [finding({}), finding({ id: "f2" })], true);
    expect(events).toEqual([]);
    expect([...seen].sort()).toEqual(["f1", "f2"]);
  });

  test("a new finding after seeding emits one fully-shaped frame", () => {
    const seen = new Set(["f1"]);
    const events = diffAutoFindingEvents(seen, [finding({}), finding({ id: "f2", severity: "high" })], false);
    expect(events).toEqual([
      {
        type: "event",
        event: "auto.finding",
        sessionId: "auto:f2",
        title: "3 stale PRs are blocking the release branch",
        project: null,
        agent: "inbox-triage",
        findingId: "f2",
        severity: "high",
        reasoning: ["PR #12 has been open 9 days", "PR #14 conflicts with main"],
        suggest: "rebase #14 first",
        ts: 1000,
      },
    ]);
  });

  test("a repeat poll of the same open findings emits nothing", () => {
    const seen = new Set<string>();
    expect(diffAutoFindingEvents(seen, [finding({})], false)).toHaveLength(1);
    expect(diffAutoFindingEvents(seen, [finding({})], false)).toEqual([]);
  });

  test("findings that drop out of the open list are pruned from the baseline", () => {
    const seen = new Set(["f1", "f2"]);
    diffAutoFindingEvents(seen, [finding({ id: "f2" })], false);
    expect([...seen]).toEqual(["f2"]);
  });

  test("caps emissions per tick so a bulk run can't flood the channel", () => {
    const seen = new Set<string>();
    const many = Array.from({ length: 9 }, (_, i) => finding({ id: `bulk-${i}` }));
    const events = diffAutoFindingEvents(seen, many, false);
    expect(events).toHaveLength(5);
    // Over-cap rows are still baselined — they are dropped, not queued.
    expect(seen.size).toBe(9);
    expect(diffAutoFindingEvents(seen, many, false)).toEqual([]);
  });

  test("skips non-open rows (an older serve may ignore ?status=open) and empty titles", () => {
    const seen = new Set<string>();
    const events = diffAutoFindingEvents(
      seen,
      [finding({ id: "done", status: "dismissed" }), finding({ id: "blank", title: "   " }), finding({ id: "ok" })],
      false,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.findingId).toBe("ok");
    expect([...seen]).toEqual(["ok"]);
  });

  test("caps reasoning lines and normalizes missing optional fields", () => {
    const seen = new Set<string>();
    const events = diffAutoFindingEvents(
      seen,
      [finding({ reasoning: ["a", "b", "", "c", "d", "e"], suggest: undefined, severity: undefined, agentId: undefined })],
      false,
    );
    expect(events[0]!.reasoning).toEqual(["a", "b", "c", "d"]);
    expect(events[0]!.suggest).toBeNull();
    expect(events[0]!.severity).toBe("low");
    expect(events[0]!.agent).toBeNull();
  });
});

describe("diffAskEvents", () => {
  const ask = (over: Partial<import("../src/commands/connect").AskLite>) => ({
    id: "q1",
    question: "Ship the migration now or wait for the backup?",
    options: ["ship", "wait"],
    agentId: "release-bot",
    sessionId: null,
    status: "open",
    createdAt: 2000,
    ...over,
  });

  test("first poll only seeds the baseline — a parked question isn't re-asked on restart", () => {
    const seen = new Set<string>();
    expect(diffAskEvents(seen, [ask({}), ask({ id: "q2" })], true)).toEqual([]);
    expect([...seen].sort()).toEqual(["q1", "q2"]);
  });

  test("a new open question emits one fully-shaped frame with the ask: fallback id", () => {
    const seen = new Set(["q1"]);
    const events = diffAskEvents(seen, [ask({}), ask({ id: "q2" })], false);
    expect(events).toEqual([
      {
        type: "event",
        event: "auto.question",
        sessionId: "ask:q2",
        title: null,
        project: null,
        agent: "release-bot",
        questionId: "q2",
        question: "Ship the migration now or wait for the backup?",
        options: ["ship", "wait"],
        ts: 2000,
      },
    ]);
  });

  test("a question bound to a live session keeps that sessionId", () => {
    const seen = new Set<string>();
    const events = diffAskEvents(seen, [ask({ sessionId: "sess-9" })], false);
    expect(events[0]!.sessionId).toBe("sess-9");
  });

  test("a repeat poll of the same open question emits nothing", () => {
    const seen = new Set<string>();
    expect(diffAskEvents(seen, [ask({})], false)).toHaveLength(1);
    expect(diffAskEvents(seen, [ask({})], false)).toEqual([]);
  });

  test("answered questions drop out of the open list and are pruned", () => {
    const seen = new Set(["q1", "q2"]);
    diffAskEvents(seen, [ask({ id: "q2" })], false);
    expect([...seen]).toEqual(["q2"]);
  });

  test("caps emissions per tick", () => {
    const seen = new Set<string>();
    const many = Array.from({ length: 8 }, (_, i) => ask({ id: `q-${i}` }));
    expect(diffAskEvents(seen, many, false)).toHaveLength(5);
    expect(seen.size).toBe(8);
  });

  test("skips non-open rows and empty question text, and caps options", () => {
    const seen = new Set<string>();
    const events = diffAskEvents(
      seen,
      [
        ask({ id: "answered", status: "answered" }),
        ask({ id: "blank", question: "  " }),
        ask({ id: "ok", options: ["a", "b", "", "c", "d", "e"], agentId: null }),
      ],
      false,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.questionId).toBe("ok");
    expect(events[0]!.options).toEqual(["a", "b", "c", "d"]);
    expect(events[0]!.agent).toBeNull();
    expect([...seen]).toEqual(["ok"]);
  });
});

// ---- Binary framing + streamed http responses ----
//
// The JSON-only protocol had to base64 every payload byte, which cost a 4/3
// inflation and — because a response had to fit in ONE frame — let a large
// artifact exceed the relay's frame ceiling. An oversized frame does not fail
// the request; the relay's WebSocket server closes the box's connection. These
// pin the wire format, the negotiation that keeps old peers working, and the
// streaming path that makes body size independent of frame size.

describe("binary frame codec", () => {
  test("round-trips a header and raw payload", () => {
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const decoded = decodeBinaryFrame(encodeBinaryFrame({ type: "http-body", id: "r1" }, payload));
    expect(decoded?.header).toEqual({ type: "http-body", id: "r1" });
    expect(Array.from(decoded!.payload)).toEqual(Array.from(payload));
  });

  test("survives a payload that is not valid UTF-8", () => {
    // The whole point of binary framing: these bytes cannot survive a string
    // round trip, which is why the JSON path had to base64 them.
    const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const decoded = decodeBinaryFrame(encodeBinaryFrame({ type: "ws-msg", id: "t", binary: true }, payload));
    expect(Array.from(decoded!.payload)).toEqual([0xff, 0xfe, 0x00, 0x80]);
  });

  test("handles an empty payload and a large one", () => {
    expect(decodeBinaryFrame(encodeBinaryFrame({ type: "x" }, new Uint8Array(0)))?.payload.length).toBe(0);
    const big = new Uint8Array(1_000_000).fill(9);
    const decoded = decodeBinaryFrame(encodeBinaryFrame({ type: "x" }, big));
    expect(decoded?.payload.length).toBe(1_000_000);
    expect(decoded?.payload[999_999]).toBe(9);
  });

  test("rejects junk rather than throwing, so a bad frame can fall through to JSON", () => {
    expect(decodeBinaryFrame(new Uint8Array([1, 2]))).toBeNull();
    expect(decodeBinaryFrame(new Uint8Array([0, 0, 0, 0]))).toBeNull();
    // Header length longer than the frame.
    const truncated = new Uint8Array(8);
    new DataView(truncated.buffer).setUint32(0, 999, false);
    expect(decodeBinaryFrame(truncated)).toBeNull();
    // Well-formed length, unparseable JSON.
    const badJson = new Uint8Array(4 + 3);
    new DataView(badJson.buffer).setUint32(0, 3, false);
    badJson.set(new TextEncoder().encode("{{{"), 4);
    expect(decodeBinaryFrame(badJson)).toBeNull();
  });

  test("a text JSON frame is never mistaken for a binary one", () => {
    const json = new TextEncoder().encode(JSON.stringify({ type: "ping" }));
    expect(decodeBinaryFrame(json)).toBeNull();
  });
});

describe("capability negotiation", () => {
  test("keeps only what both ends speak", () => {
    expect(negotiateCaps(["binary", "http-stream"])).toEqual(["binary", "http-stream"]);
    expect(negotiateCaps(["binary"])).toEqual(["binary"]);
    expect(negotiateCaps(["telepathy"])).toEqual([]);
  });

  test("a peer that predates negotiation yields no caps, not a crash", () => {
    // This is the backward-compatibility contract in one line: absent `caps`
    // must mean "legacy JSON only", never "assume the new format".
    expect(negotiateCaps(undefined)).toEqual([]);
    expect(negotiateCaps(null)).toEqual([]);
    expect(negotiateCaps("binary")).toEqual([]);
    expect(negotiateCaps([1, 2, 3])).toEqual([]);
  });
});

describe("streamToLocalServe", () => {
  /** Collects what the box would put on the wire. */
  function recorder() {
    const json: Array<Record<string, unknown>> = [];
    const binary: Array<{ header: Record<string, unknown>; payload: Uint8Array }> = [];
    return {
      json,
      binary,
      sendJson: (p: unknown) => json.push(p as Record<string, unknown>),
      sendBinary: (header: Record<string, unknown>, payload: Uint8Array) =>
        binary.push({ header, payload: new Uint8Array(payload) }),
      body: () => {
        const total = binary.reduce((n, b) => n + b.payload.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const b of binary) { out.set(b.payload, at); at += b.payload.length; }
        return out;
      },
    };
  }

  test("streams a body larger than any single frame, in order and intact", async () => {
    // 26 MB is the artifact that took the box offline on the buffered path.
    const total = 27_508_662;
    const chunkSize = 64 * 1024;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) { controller.close(); return; }
        const size = Math.min(chunkSize, total - sent);
        const chunk = new Uint8Array(size);
        // A recognisable, position-dependent pattern so reordering or a
        // dropped chunk cannot pass.
        for (let i = 0; i < size; i++) chunk[i] = (sent + i) % 251;
        sent += size;
        controller.enqueue(chunk);
      },
    });
    const rec = recorder();
    await streamToLocalServe(
      { type: "http", id: "req-big", method: "GET", path: "/api/artifacts/vid" },
      rec.sendBinary,
      rec.sendJson,
      (async () => new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } })) as unknown as typeof fetch,
    );

    expect(rec.json[0]).toMatchObject({ type: "http-head", id: "req-big", status: 200 });
    expect(rec.json.at(-1)).toEqual({ type: "http-end", id: "req-big" });
    expect(rec.binary.length).toBeGreaterThan(1);
    // No frame carries anything close to a whole body.
    for (const frame of rec.binary) {
      expect(frame.header).toEqual({ type: "http-body", id: "req-big" });
      expect(frame.payload.length).toBeLessThanOrEqual(chunkSize);
    }
    const body = rec.body();
    expect(body.length).toBe(total);
    expect(body[0]).toBe(0);
    expect(body[total - 1]).toBe((total - 1) % 251);
    expect(body[12_345_678]).toBe(12_345_678 % 251);
  });

  test("reports the status and headers before any body arrives", async () => {
    const rec = recorder();
    await streamToLocalServe(
      { type: "http", id: "r", method: "GET", path: "/nope" },
      rec.sendBinary,
      rec.sendJson,
      (async () => new Response("missing", { status: 404, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch,
    );
    expect(rec.json[0]).toMatchObject({ type: "http-head", id: "r", status: 404 });
    expect(new TextDecoder().decode(rec.body())).toBe("missing");
  });

  test("an unreachable local serve becomes a 502 head, not a dropped request", async () => {
    const rec = recorder();
    await streamToLocalServe(
      { type: "http", id: "r", method: "GET", path: "/x" },
      rec.sendBinary,
      rec.sendJson,
      (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    );
    expect(rec.json[0]).toMatchObject({ type: "http-head", id: "r", status: 502 });
    expect(new TextDecoder().decode(rec.body())).toContain("local serve unreachable");
    expect(rec.json.at(-1)).toEqual({ type: "http-end", id: "r" });
  });

  test("a body that dies mid-stream ends with an error rather than looking complete", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      pull() { throw new Error("disk went away"); },
    });
    const rec = recorder();
    await streamToLocalServe(
      { type: "http", id: "r", method: "GET", path: "/x" },
      rec.sendBinary,
      rec.sendJson,
      (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch,
    );
    const end = rec.json.at(-1) as { type: string; error?: string };
    expect(end.type).toBe("http-end");
    expect(end.error).toContain("disk went away");
  });
});

describe("tunnel payload framing", () => {
  test("a relayed binary ws-msg reaches the local socket as raw bytes", () => {
    const sent: unknown[] = [];
    const tunnels = new Map([["t1", { send: (d: unknown) => sent.push(d) } as unknown as WebSocket]]);
    const payload = new Uint8Array([0xff, 0x00, 0x80]);
    applyWsTunnelFrame({ type: "ws-msg", id: "t1", binary: true }, tunnels, payload);
    expect(Array.from(sent[0] as Uint8Array)).toEqual([0xff, 0x00, 0x80]);
  });

  test("a legacy base64 ws-msg still works when no payload accompanies it", () => {
    const sent: unknown[] = [];
    const tunnels = new Map([["t1", { send: (d: unknown) => sent.push(d) } as unknown as WebSocket]]);
    applyWsTunnelFrame(
      { type: "ws-msg", id: "t1", binary: false, dataB64: Buffer.from("hi").toString("base64") },
      tunnels,
    );
    expect(sent[0]).toBe("hi");
  });
});
