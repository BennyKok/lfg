import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sessionTokenUsage } from "./session-token-usage.ts";

const roots: string[] = [];

function fixturePath(provider: "codex" | "claude", rows: unknown[]): string {
  const root = join(tmpdir(), `lfg-session-usage-${crypto.randomUUID()}`);
  roots.push(root);
  const dir = provider === "codex" ? join(root, ".codex", "sessions") : join(root, ".claude", "projects");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sessionTokenUsage", () => {
  test("reads authoritative Codex counters and estimates prompt categories", async () => {
    const path = fixturePath("codex", [
      {
        type: "session_meta",
        payload: { base_instructions: { text: "fallback base instructions" } },
      },
      {
        type: "turn_context",
        payload: { model: "gpt-test", summary: "A compacted conversation summary." },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "General system rules." },
            {
              type: "input_text",
              text: "<skills_instructions>## Skills\n- imagegen</skills_instructions>",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "=== USER TASK ===\nBuild the usage view." }],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", arguments: "{\"cmd\":\"pwd\"}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", output: "/work" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-28T00:00:00Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 12_000,
              cached_input_tokens: 8_000,
              output_tokens: 900,
              reasoning_output_tokens: 300,
              total_tokens: 12_900,
            },
            last_token_usage: { input_tokens: 4_000, output_tokens: 200 },
            model_context_window: 10_000,
          },
        },
      },
    ]);

    const usage = await sessionTokenUsage(crypto.randomUUID(), path);

    expect(usage.source).toBe("codex-transcript");
    expect(usage.context).toEqual({ used: 4_200, max: 10_000, free: 5_800, percent: 42 });
    expect(usage.totals).toMatchObject({
      input: 4_000,
      output: 900,
      cacheRead: 8_000,
      reasoning: 300,
      total: 12_900,
    });
    expect(usage.categories.map((category) => category.name)).toEqual(
      expect.arrayContaining([
        "System prompt",
        "Skills",
        "User messages",
        "Tool calls",
        "Tool results",
        "Compaction summary",
        "Other context",
      ]),
    );
    expect(usage.categories.every((category) => category.accuracy === "estimated")).toBe(true);
  });

  test("deduplicates repeated Claude transcript envelopes by request id", async () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    };
    const path = fixturePath("claude", [
      {
        type: "assistant",
        requestId: "request-1",
        timestamp: "2026-07-28T00:00:00Z",
        message: { id: "message-1", model: "claude-test", usage },
      },
      {
        type: "assistant",
        requestId: "request-1",
        timestamp: "2026-07-28T00:00:01Z",
        message: { id: "message-1", model: "claude-test", usage },
      },
    ]);

    const result = await sessionTokenUsage(crypto.randomUUID(), path);

    expect(result.source).toBe("claude-transcript");
    expect(result.context.used).toBe(100);
    expect(result.totals).toMatchObject({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      total: 100,
    });
  });
});
