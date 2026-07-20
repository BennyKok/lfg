import { afterEach, describe, expect, test } from "bun:test";
import { closeLfgSession } from "./mcp.ts";

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
