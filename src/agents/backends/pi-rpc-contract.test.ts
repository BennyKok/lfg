import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";

// pi-session.ts depends on three things that live entirely outside the type
// system, so a pi upgrade can break every session while the build stays green:
//
//   1. `~/.pi/agent/models.json` — ensurePiProviderConfig() writes a provider
//      override there to point pi's "anthropic" provider at the sandbox's local
//      LLM proxy. Nothing imports that file's schema; it is a wire contract with
//      pi's config loader. pi 0.83 rewrote pi-ai's provider layer wholesale,
//      which is exactly the kind of change that silently invalidates it.
//   2. The RPC handshake — the client spawns `pi --mode rpc` and speaks JSONL.
//   3. The event names the harness switches on (message_update / message_end /
//      tool_execution_*) and waitForIdle's completion signal, which 0.83 moved
//      from `agent_end` to `agent_settled`.
//
// So drive a real turn against a stub Anthropic Messages endpoint. No
// credentials, no network, ~2s — and it fails loudly if any of the three drift.

const TEMP = mkdtempSync(join(tmpdir(), "pi-rpc-contract-"));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** The smallest Anthropic Messages stream pi will accept as one assistant turn. */
function startStubAnthropic(reply: string[]) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages")) {
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      requests++;
      await req.json();
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              enc.encode(
                sse("message_start", {
                  type: "message_start",
                  message: {
                    id: "msg_stub",
                    type: "message",
                    role: "assistant",
                    model: "claude-sonnet-5",
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 7, output_tokens: 0 },
                  },
                }),
              ),
            );
            c.enqueue(
              enc.encode(
                sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
              ),
            );
            for (const text of reply) {
              c.enqueue(
                enc.encode(
                  sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
                ),
              );
            }
            c.enqueue(enc.encode(sse("content_block_stop", { type: "content_block_stop", index: 0 })));
            c.enqueue(
              enc.encode(
                sse("message_delta", {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn", stop_sequence: null },
                  usage: { output_tokens: reply.length },
                }),
              ),
            );
            c.enqueue(enc.encode(sse("message_stop", { type: "message_stop" })));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}`, requestCount: () => requests };
}

/** Byte-for-byte the config ensurePiProviderConfig() writes in pi-session.ts. */
function writePiProviderConfig(home: string, baseUrl: string) {
  const dir = join(home, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({ providers: { anthropic: { baseUrl, models: [{ id: "deepseek/deepseek-v4-flash" }] } } }, null, 2),
  );
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.HOME = home;
  env.ANTHROPIC_API_KEY = "stub-key-not-used-by-the-stub";
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

test(
  "a pi turn streams through the RPC backend with the provider override applied",
  async () => {
    const home = join(TEMP, "home");
    const cwd = join(TEMP, "work");
    mkdirSync(cwd, { recursive: true });
    const stub = startStubAnthropic(["PONG", "-FROM", "-STUB"]);
    writePiProviderConfig(home, stub.baseUrl);

    const client = new RpcClient({
      // Same resolution the harness uses — see resolvePiCliPath().
      cliPath: join(import.meta.dir, "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      cwd,
      env: childEnv(home),
      provider: "anthropic",
      model: "sonnet",
    });

    const seen: string[] = [];
    let streamed = "";
    let finalText = "";
    client.onEvent((event: AgentSessionEvent) => {
      seen.push(event.type);
      if (event.type === "message_update") {
        const ev = (event as unknown as { assistantMessageEvent: { type: string; delta?: string } }).assistantMessageEvent;
        if (ev.type === "text_delta" && typeof ev.delta === "string") streamed += ev.delta;
        return;
      }
      if (event.type === "message_end") {
        const message = (event as unknown as { message: { role: string; content: Array<{ type: string; text?: string }> } })
          .message;
        if (message.role !== "assistant") return;
        for (const block of message.content) if (block.type === "text" && block.text) finalText ||= block.text;
      }
    });

    try {
      await client.start();

      // The provider override took effect: pi resolved the model against the
      // stub, not api.anthropic.com. This is the assertion that catches a
      // models.json schema change.
      const state = await client.getState();
      expect(state.sessionId).toBeTruthy();
      expect((state.model as { baseUrl?: string } | undefined)?.baseUrl).toBe(stub.baseUrl);

      await client.prompt("say pong");
      await client.waitForIdle(60_000);
    } finally {
      await client.stop().catch(() => {});
      stub.server.stop(true);
    }

    expect(stub.requestCount()).toBeGreaterThan(0);
    // Streamed deltas and the settled message must both carry the full reply —
    // the harness publishes the first as a live draft and indexes the second.
    expect(streamed).toBe("PONG-FROM-STUB");
    expect(finalText).toBe("PONG-FROM-STUB");
    expect(seen).toContain("message_update");
    expect(seen).toContain("message_end");
    // waitForIdle resolves on this in 0.83; it was `agent_end` before.
    expect(seen).toContain("agent_settled");
  },
  120_000,
);
