// Every agent launch has to tell the shared MCP endpoint which session it is.
//
// MCP is served by the `lfg serve` process, not a child of each agent, so the
// endpoint can't read the caller out of its own environment — the launcher has
// to put it in the URL (Claude) or pass it through explicitly (Codex, which
// sanitizes the environment of MCP servers it spawns).
//
// This is a source-level ratchet because the failure is a *missing* call in a
// file nobody remembered: the first fix wired claude-ai-sdk.ts, the
// report-generation backend, and missed aisdk-session.ts, which is what
// actually runs interactive sessions. Both drive the Agent SDK's `query()`, and
// a unit test of the helper passes happily while a call site goes unwired.
// Importing these modules to check for real isn't an option — they're session
// harnesses that execute on import.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { omgMcpServers } from "./config.ts";

const BACKENDS = join(import.meta.dir, "agents", "backends");

function backendSources(): { name: string; text: string }[] {
  return readdirSync(BACKENDS)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(join(BACKENDS, name), "utf8") }));
}

describe("session identity reaches every agent launcher", () => {
  test("every Claude Agent SDK query() call site registers this session's MCP URL", () => {
    const drivers = backendSources().filter(
      (f) => f.text.includes("@anthropic-ai/claude-agent-sdk") && f.text.includes("query({"),
    );

    // If this is zero the test has stopped testing anything — the import string
    // or call shape changed and the filter silently matches nothing.
    expect(drivers.length).toBeGreaterThan(0);

    // Match the spread call, not the identifier: an import left behind after
    // the call site was removed would satisfy a bare `includes("omgMcpServers")`
    // and wave the regression straight through.
    const unwired = drivers
      .filter((f) => !/\.\.\.\s*omgMcpServers\(/.test(f.text))
      .map((f) => f.name);
    expect(unwired).toEqual([]);
  });

  test("the Codex launcher passes the session id through to its MCP child", () => {
    const codex = backendSources().filter((f) => f.text.includes("@openai/codex-sdk"));
    expect(codex.length).toBeGreaterThan(0);

    // Codex spawns `lfg mcp` over stdio with a sanitized environment, so the id
    // has to ride a per-launch --config override instead of the environment.
    const unwired = codex
      .filter((f) => !(f.text.includes("mcp_servers") && f.text.includes("LFG_SESSION_ID")))
      .map((f) => f.name);
    expect(unwired).toEqual([]);
  });
});

describe("omgMcpServers", () => {
  const originalSessionId = process.env.LFG_SESSION_ID;
  const originalBase = process.env.LFG_BASE;

  function restore() {
    if (originalSessionId === undefined) delete process.env.LFG_SESSION_ID;
    else process.env.LFG_SESSION_ID = originalSessionId;
    if (originalBase === undefined) delete process.env.LFG_BASE;
    else process.env.LFG_BASE = originalBase;
  }

  test("names the session in the endpoint URL", () => {
    process.env.LFG_BASE = "http://127.0.0.1:8766";
    try {
      expect(omgMcpServers("ba4522bc-6607-4691-b69e-8b99cfb3ead2")).toEqual({
        mcpServers: {
          omg: {
            type: "http",
            url: "http://127.0.0.1:8766/mcp?session=ba4522bc-6607-4691-b69e-8b99cfb3ead2",
          },
        },
      });
    } finally {
      restore();
    }
  });

  test("falls back to the ambient session when the caller passes none", () => {
    process.env.LFG_BASE = "http://127.0.0.1:8766";
    process.env.LFG_SESSION_ID = "ambient-session";
    try {
      expect(omgMcpServers().mcpServers?.omg.url).toContain("session=ambient-session");
    } finally {
      restore();
    }
  });

  test("registers nothing outside a managed session", () => {
    delete process.env.LFG_SESSION_ID;
    try {
      // An empty object leaves the user-scope registration in charge rather
      // than pointing the agent at a URL naming no session.
      expect(omgMcpServers()).toEqual({});
      expect(omgMcpServers("   ")).toEqual({});
    } finally {
      restore();
    }
  });
});
