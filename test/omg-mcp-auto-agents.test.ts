// The auto agent fleet, driven over MCP.
//
// Auto agents (a prompt + a cron schedule, reporting findings) were reachable
// only from the web UI, so an agent asked to "check this every morning" had no
// way to set one up. These tools proxy the same /api/auto/* routes the UI calls,
// which is the property worth guarding: one store, one scheduler, no second
// code path that can drift from what the UI does.
//
// Also covers the pre-rename tool names. Every tool was `lfg_*` before the OMG
// rebrand, and an agent reads the tool catalog once at session start — so every
// session running when the rename shipped still calls the old names for hours
// afterwards. They are aliased at the wire, not registered twice.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serveOmgMcpRequest } from "../src/mcp-http.ts";

const originalFetch = globalThis.fetch;
const originalBase = process.env.LFG_BASE;
const originalSessionId = process.env.LFG_SESSION_ID;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let reply: unknown = {};

beforeEach(() => {
  calls = [];
  reply = {};
  process.env.LFG_BASE = "http://127.0.0.1:9876";
  delete process.env.LFG_SESSION_ID;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    return Response.json(reply as Record<string, unknown>);
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

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolReply> {
  const res = await serveOmgMcpRequest(
    new Request("http://127.0.0.1:8766/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
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

async function listTools(): Promise<string[]> {
  const res = await serveOmgMcpRequest(
    new Request("http://127.0.0.1:8766/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

describe("auto agents over MCP", () => {
  test("lists the scheduled fleet with its time zone", async () => {
    reply = { agents: [{ id: "wal-check", name: "WAL check" }], tz: "Europe/Lisbon" };
    const out = await callTool("omg_list_auto_agents");

    expect(out.isError).toBe(false);
    expect(calls).toEqual([
      { url: "http://127.0.0.1:9876/api/auto/agents", method: "GET", body: undefined },
    ]);
    expect(JSON.parse(out.text)).toEqual({
      agents: [{ id: "wal-check", name: "WAL check" }],
      timeZone: "Europe/Lisbon",
    });
  });

  test("creates an agent through the same route the UI posts to", async () => {
    reply = { agent: { id: "backup-restore", name: "Backup restore" } };
    const out = await callTool("omg_save_auto_agent", {
      name: "Backup restore",
      prompt: "Verify last night's backup actually restored.",
      schedule: "0 7 * * *",
      cwd: "/home/dev/repos/omg",
    });

    expect(out.isError).toBe(false);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/auto/agents");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({
      name: "Backup restore",
      prompt: "Verify last night's backup actually restored.",
      schedule: "0 7 * * *",
      cwd: "/home/dev/repos/omg",
    });
    // No id supplied → a create, and the reply says so rather than leaving the
    // agent to guess whether it just overwrote something.
    expect(JSON.parse(out.text).updated).toBe(false);
  });

  test("saving with an id is an in-place update, not a second agent", async () => {
    reply = { agent: { id: "wal-check" } };
    const out = await callTool("omg_save_auto_agent", {
      id: "wal-check",
      name: "WAL check",
      prompt: "Check the WAL size.",
      schedule: "*/30 * * * *",
      enabled: false,
    });

    expect(calls[0]?.body).toMatchObject({ id: "wal-check", enabled: false });
    expect(JSON.parse(out.text).updated).toBe(true);
  });

  test("rejects a backend the scheduler cannot run", async () => {
    const out = await callTool("omg_save_auto_agent", {
      name: "Bad backend",
      prompt: "...",
      schedule: "0 * * * *",
      agent: "not-a-backend",
    });

    // Caught by the schema, so it never reaches the server.
    expect(out.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("runs an agent on demand and tells the caller not to poll", async () => {
    reply = { ok: true };
    const out = await callTool("omg_run_auto_agent", { id: "wal-check" });

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9876/api/auto/agents/wal-check/run",
      method: "POST",
    });
    // The route is fire-and-forget; an agent that polls it burns a session.
    expect(JSON.parse(out.text).next).toContain("Do not poll");
  });

  test("deletes an agent", async () => {
    reply = { ok: true };
    await callTool("omg_delete_auto_agent", { id: "wal-check" });

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9876/api/auto/agents/wal-check",
      method: "DELETE",
    });
  });

  test("path-encodes ids instead of splicing them into the URL", async () => {
    reply = { ok: true };
    await callTool("omg_delete_auto_agent", { id: "a/../b" });

    expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/auto/agents/a%2F..%2Fb");
  });

  test("composes a draft without scheduling anything", async () => {
    reply = { draft: { name: "Nightly backup check", schedule: "0 7 * * *" } };
    const out = await callTool("omg_compose_auto_agent", {
      prompt: "watch whether the nightly backup restored",
    });

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9876/api/auto/compose",
      method: "POST",
    });
    // Composing must not be mistaken for saving — nothing runs until it is saved.
    expect(JSON.parse(out.text).next).toContain("omg_save_auto_agent");
  });

  test("defaults findings to the open ones", async () => {
    reply = { findings: [] };
    await callTool("omg_list_findings");

    expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/auto/findings?status=open");
  });

  test("filters findings by lifecycle status", async () => {
    reply = { findings: [] };
    await callTool("omg_list_findings", { status: "resolved" });

    expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/auto/findings?status=resolved");
  });

  test("updates a finding's status", async () => {
    reply = { finding: { id: "abc123", status: "resolved" } };
    const out = await callTool("omg_update_finding", { id: "abc123", status: "resolved" });

    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9876/api/auto/findings/abc123",
      method: "POST",
    });
    expect(calls[0]?.body).toMatchObject({ status: "resolved" });
    expect(JSON.parse(out.text).finding).toEqual({ id: "abc123", status: "resolved" });
  });

  test("refuses a status the finding store does not model", async () => {
    const out = await callTool("omg_update_finding", { id: "abc123", status: "fixed" });

    expect(out.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("pre-rename tool names", () => {
  test("the catalog advertises omg_* only", async () => {
    const tools = await listTools();

    expect(tools.length).toBeGreaterThan(20);
    expect(tools).toContain("omg_ship");
    expect(tools).toContain("omg_list_auto_agents");
    // Registering both spellings would double a 30-tool catalog in the context
    // window of every new session, forever, to serve a transition that ends.
    expect(tools.filter((name) => name.startsWith("lfg_"))).toEqual([]);
  });

  test("a session that still holds the old catalog keeps working", async () => {
    reply = { agents: [], tz: "UTC" };
    // Exactly what a session launched before the rename sends.
    const out = await callTool("lfg_list_auto_agents");

    expect(out.isError).toBe(false);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9876/api/auto/agents");
  });

  test("the alias carries arguments through untouched", async () => {
    reply = { ok: true };
    const out = await callTool("lfg_run_auto_agent", { id: "wal-check" });

    expect(out.isError).toBe(false);
    expect(calls[0]).toMatchObject({
      url: "http://127.0.0.1:9876/api/auto/agents/wal-check/run",
      method: "POST",
    });
  });

  test("an unknown legacy name still fails rather than resolving to something else", async () => {
    const out = await callTool("lfg_not_a_real_tool", {});

    expect(out.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
