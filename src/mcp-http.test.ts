// The shared MCP endpoint has to know *which* session is calling.
//
// Regression guard for ed3953d ("serve MCP from the server instead of one
// process per session"). That change was justified by "the MCP server holds no
// state" — true of everything except the one thing that mattered: the identity
// of the calling session, which a stdio child got for free from LFG_SESSION_ID
// and the shared `lfg serve` process cannot. Every session-scoped tool
// (lfg_display_image, lfg_display_video, lfg_publish_artifact, lfg_input,
// lfg_send_to_origin) silently failed with "sessionId required" for five days
// across 21 sessions, and the session-ownership guards degraded to no-ops.
//
// These tests run with LFG_SESSION_ID unset, which is what the serve process
// actually looks like — the bug is invisible in any test that leaves it set.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serveLfgMcpRequest } from "./mcp-http.ts";

const SESSION = "ba4522bc-6607-4691-b69e-8b99cfb3ead2";
const OTHER = "99999999-2222-4222-8222-222222222222";

const originalFetch = globalThis.fetch;
const originalBase = process.env.LFG_BASE;
const originalSessionId = process.env.LFG_SESSION_ID;

/** Outbound API calls the tool made, in order. */
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  process.env.LFG_BASE = "http://127.0.0.1:9876";
  // The serve process answers every session and belongs to none of them.
  delete process.env.LFG_SESSION_ID;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return Response.json({ artifact: { id: "art-1" }, sessions: [] });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.LFG_BASE;
  else process.env.LFG_BASE = originalBase;
  if (originalSessionId === undefined) delete process.env.LFG_SESSION_ID;
  else process.env.LFG_SESSION_ID = originalSessionId;
});

type ToolReply = { text: string; isError: boolean };

async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { session?: string; header?: boolean } = {},
): Promise<ToolReply> {
  const url = new URL("http://127.0.0.1:8766/mcp");
  if (opts.session && !opts.header) url.searchParams.set("session", opts.session);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.session && opts.header) headers["x-lfg-session-id"] = opts.session;

  const res = await serveLfgMcpRequest(
    new Request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await res.json()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
  };
  return {
    text: body.result?.content?.[0]?.text ?? "",
    isError: body.result?.isError === true,
  };
}

describe("caller identity over the shared MCP endpoint", () => {
  test("display_image publishes to the calling session named on the request", async () => {
    const reply = await callTool(
      "lfg_display_image",
      { path: "/tmp/shot.png", caption: "a screenshot" },
      { session: SESSION },
    );

    // The actual regression: this came back "sessionId required" and no
    // artifact was ever created, so screenshots silently never appeared.
    expect(reply.isError).toBe(false);
    expect(calls).toEqual([
      `http://127.0.0.1:9876/api/sessions/${SESSION}/artifacts/images`,
    ]);
  });

  test("a client that cannot carry a query string may send the session header", async () => {
    const reply = await callTool(
      "lfg_display_video",
      { path: "/tmp/clip.mp4" },
      { session: SESSION, header: true },
    );

    expect(reply.isError).toBe(false);
    expect(calls).toEqual([
      `http://127.0.0.1:9876/api/sessions/${SESSION}/artifacts/videos`,
    ]);
  });

  test("an explicit sessionId argument still wins over the request's identity", async () => {
    await callTool(
      "lfg_display_image",
      { path: "/tmp/shot.png", sessionId: OTHER },
      { session: SESSION },
    );

    expect(calls).toEqual([
      `http://127.0.0.1:9876/api/sessions/${OTHER}/artifacts/images`,
    ]);
  });

  test("an anonymous request still refuses to guess a session", async () => {
    const reply = await callTool("lfg_display_image", { path: "/tmp/shot.png" });

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("sessionId required");
    expect(calls).toEqual([]);
  });

  test("session-owned actions cannot target another session", async () => {
    // This guard reads the caller too, so in the shared process it had quietly
    // become a no-op: any session could publish artifacts into any other.
    const reply = await callTool(
      "lfg_publish_artifact",
      {
        html: "<html><body>hi</body></html>",
        id: "report",
        refreshIntervalSeconds: 60,
        sessionId: OTHER,
      },
      { session: SESSION },
    );

    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("can only target their owning LFG session");
  });
});
