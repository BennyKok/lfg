import { afterEach, describe, expect, test } from "bun:test";
import { closeLfgSession, findLfgSessions, sendToOrigin } from "./mcp.ts";

const originalFetch = globalThis.fetch;
const originalBase = process.env.LFG_BASE;
const originalSessionId = process.env.LFG_SESSION_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.LFG_BASE;
  else process.env.LFG_BASE = originalBase;
  if (originalSessionId === undefined) delete process.env.LFG_SESSION_ID;
  else process.env.LFG_SESSION_ID = originalSessionId;
});

describe("closeLfgSession", () => {
  test("closes an exact target through the public session close API", async () => {
    process.env.LFG_BASE = "http://127.0.0.1:9876";
    process.env.LFG_SESSION_ID = "caller-session";
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return Response.json({ ok: true });
    }) as typeof fetch;

    await expect(closeLfgSession(" target-session ")).resolves.toEqual({
      closed: true,
      sessionId: "target-session",
    });
    expect(request?.url).toBe("http://127.0.0.1:9876/api/sessions/target-session/close");
    expect(request?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ source: "mcp_lfg_close_session" }),
    });
  });

  test("refuses to close the calling session", async () => {
    process.env.LFG_SESSION_ID = "same-session";
    await expect(closeLfgSession("same-session")).rejects.toThrow(
      "lfg_close_session cannot close the calling session",
    );
  });
});

describe("findLfgSessions", () => {
  test("queries the historical session API with composable filters", async () => {
    process.env.LFG_BASE = "http://127.0.0.1:9876";
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return Response.json({ sessions: [], candidateTotal: 0, scanned: 0, truncated: false });
    }) as typeof fetch;

    await expect(findLfgSessions({
      sessionId: "abcd",
      user: "dev@example.com",
      project: "/repos/lfg",
      text: "historical finder",
      activeAfter: "2026-07-01T00:00:00Z",
      activeBefore: "2026-07-24T00:00:00Z",
      limit: 20,
      scanLimit: 100,
    })).resolves.toMatchObject({ sessions: [], candidateTotal: 0 });
    expect(request?.url).toBe("http://127.0.0.1:9876/api/sessions/find");
    expect(request?.init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "abcd",
        user: "dev@example.com",
        project: "/repos/lfg",
        text: "historical finder",
        activeAfter: "2026-07-01T00:00:00Z",
        activeBefore: "2026-07-24T00:00:00Z",
        limit: 20,
        scanLimit: 100,
      }),
    });
  });
});

describe("sendToOrigin", () => {
  test("posts a session-owned channel-neutral delivery", async () => {
    process.env.LFG_BASE = "http://127.0.0.1:9876";
    process.env.LFG_SESSION_ID = "11111111-1111-4111-8111-111111111111";
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      request = { url: String(url), init };
      return Response.json({ ok: true, delivery: { id: "delivery-1", target: "origin" } });
    }) as typeof fetch;

    await expect(sendToOrigin({
      text: "here it is",
      artifactIds: ["shot-1"],
    })).resolves.toMatchObject({
      delivered: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(request?.url).toEndWith(
      "/api/sessions/11111111-1111-4111-8111-111111111111/origin-deliveries",
    );
    expect(request?.init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-LFG-Session-ID": "11111111-1111-4111-8111-111111111111",
      },
    });
  });

  test("cannot deliver as another session", async () => {
    process.env.LFG_SESSION_ID = "11111111-1111-4111-8111-111111111111";
    await expect(sendToOrigin({
      text: "wrong target",
      sessionId: "22222222-2222-4222-8222-222222222222",
    })).rejects.toThrow("owning LFG session");
  });
});
