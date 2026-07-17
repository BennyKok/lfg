// Headless interactive session harness for the "pi" agent kind.
//
// This is the long-lived process behind a managed pi session. Like its
// Claude/codex/opencode siblings (./aisdk-session.ts, ./codex-aisdk-session.ts,
// ./opencode-aisdk-session.ts) it runs inside a tmux pane used purely as a
// process supervisor + lifecycle handle (we never drive I/O through the pane),
// and drives a multi-turn conversation through the OFFICIAL
// @mariozechner/pi-coding-agent RpcClient: it spawns `pi --mode rpc` as a child
// process and speaks a typed JSONL protocol over its stdin/stdout. Auth is pi's
// own file-based config (~/.pi/agent/{auth,models,settings}.json), which the
// sandbox provisions to point at a local LLM proxy — there is no interactive
// /login step, which is exactly what this backend exists to avoid (unlike
// "aisdk", which requires one against this proxy).
//
// Control plane is identical to the other harnesses:
//   - control IN: we tail a command file (data/aisdk/<key>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//
// We mint a control-plane KEY (a uuid) up front for the registry/command files.
// pi mints its OWN session id (a resume handle, like codex's threadId) once the
// RpcClient starts — unlike codex this is known almost immediately (before turn
// 1), but we still patch it in asynchronously rather than assume the timing.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import type { SessionMsg } from "../../sessions.ts";
import { indexSessionMessagesDirect } from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// pi has no separately-installed global binary we can rely on being present or
// readable (sandboxes symlink /usr/local/bin/pi into root's bun install, which
// a non-root coding user cannot traverse) — so point the RpcClient at LFG's OWN
// bundled copy of the package instead. This makes the backend self-contained:
// it only depends on pi's auth config existing under $HOME, not on any
// sandbox-specific binary install.
function resolvePiCliPath(): string {
  if (process.env.LFG_PI_PATH) return process.env.LFG_PI_PATH;
  return join(import.meta.dir, "../../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js");
}

const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactText(value: string, max = 8_000): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${value.slice(0, head)}\n\n...[${value.length - head - tail} chars omitted]...\n\n${value.slice(-tail)}`;
}

export async function cmdPiSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files. NOT pi's
  // own session id (learned right after the RpcClient starts).
  const keyArg = arg(argv, "--key");
  const model = arg(argv, "--model") ?? "sonnet";
  const thinkingLevel = arg(argv, "--thinking-level");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  // Resuming a closed pi session: its own session-file id is known up front.
  const resumeSessionId = arg(argv, "--resume");
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!keyArg) {
    console.error("pi-session: --key <uuid> is required");
    process.exit(1);
  }
  const key: string = keyArg;

  try {
    process.chdir(cwd);
  } catch {}

  const { RpcClient } = await import("@mariozechner/pi-coding-agent");
  const rpcArgs: string[] = [];
  if (thinkingLevel) rpcArgs.push("--thinking", thinkingLevel);
  if (resumeSessionId) rpcArgs.push("--session", resumeSessionId);
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    cwd,
    provider: "anthropic",
    model,
    args: rpcArgs,
  });

  let sessionId: string | null = resumeSessionId ?? null;

  // Control-plane registry entry — the moment this exists (and our pid is
  // alive), serve surfaces the session in the live view. threadId starts null
  // on fresh sessions and is patched in below once pi reports its own id.
  writeEntry({
    sessionId: key,
    agent: "pi",
    threadId: sessionId,
    harnessPid: process.pid,
    tmuxName,
    cwd,
    model,
    busy: false,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  await client.start();
  if (!sessionId) {
    try {
      const state = await client.getState();
      if (state.sessionId && state.sessionId !== sessionId) {
        sessionId = state.sessionId;
        patchEntry(key, { threadId: sessionId });
      }
    } catch {}
  }

  const queue: string[] = [];
  let draining = false;
  let closing = false;
  let aborting = false;
  const publishDraft = makeDraftPublisher(key);
  let draft = "";
  // Tool calls index once, at tool_execution_end (matches codex's per-item
  // approach) — the toolCall content block on the assistant message would
  // otherwise duplicate the same call with no result attached yet. Args only
  // arrive on tool_execution_start, so stash them keyed by call id until the
  // matching _end event has the result.
  const pendingToolCalls = new Map<string, { nonce: string; args: unknown }>();

  client.onEvent((event: AgentEvent) => {
    if (closing) return;
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta" && typeof ev.delta === "string") {
        draft += ev.delta;
        publishDraft(draft);
      }
      return;
    }
    if (event.type === "message_end") {
      if (event.message.role !== "assistant") return;
      const message = event.message as AssistantMessage;
      draft = "";
      const rows: SessionMsg[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          rows.push({ id: crypto.randomUUID(), role: "assistant", kind: "text", text: block.text, ts: Date.now() });
        } else if (block.type === "thinking" && block.thinking?.trim()) {
          rows.push({
            id: crypto.randomUUID(),
            role: "assistant",
            kind: "thinking",
            text: compactText(block.thinking),
            ts: Date.now(),
          });
        }
        // toolCall blocks are indexed at tool_execution_end instead, once the
        // result is known — indexing here too would show every call twice.
      }
      if (message.stopReason === "error" && !aborting) {
        rows.push({
          id: crypto.randomUUID(),
          role: "assistant",
          kind: "text",
          text: `⚠️ pi turn failed: ${(message.errorMessage || "unknown error").slice(0, 800)}`,
          ts: Date.now(),
          apiError: true,
        });
      }
      if (rows.length) indexSessionMessagesDirect(key, rows);
      return;
    }
    if (event.type === "tool_execution_start") {
      pendingToolCalls.set(event.toolCallId, {
        nonce: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        args: event.args,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const pending = pendingToolCalls.get(event.toolCallId);
      pendingToolCalls.delete(event.toolCallId);
      const nonce = pending?.nonce ?? crypto.randomUUID();
      const argsText = stringifyValue(pending?.args).trim();
      const resultText = stringifyValue(event.result).trim();
      const text = compactText(
        [`${event.toolName}${argsText ? `: ${argsText}` : ""}`, resultText].filter(Boolean).join("\n"),
      );
      indexSessionMessagesDirect(key, [
        {
          id: `${nonce}/${event.toolCallId}`,
          role: "assistant",
          kind: event.isError ? "tool_result" : "tool_use",
          text,
          ts: Date.now(),
        },
      ]);
      return;
    }
  });

  async function runTurn(prompt: string): Promise<void> {
    indexSessionMessagesDirect(key, [
      { id: crypto.randomUUID(), role: "user", kind: "text", text: prompt, ts: Date.now() },
    ]);
    publishDraft("", true);
    aborting = false;
    try {
      await client.prompt(prompt);
      await client.waitForIdle(TURN_TIMEOUT_MS);
    } catch (e) {
      if (aborting) return; // interrupted on purpose — not an error
      const msg = (e instanceof Error ? e.message : String(e)).trim() || "unknown error";
      console.error(`pi-session turn failed: ${msg}`);
      indexSessionMessagesDirect(key, [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          kind: "text",
          text: `⚠️ pi turn failed: ${msg.slice(0, 800)}`,
          ts: Date.now(),
          apiError: true,
        },
      ]);
    } finally {
      publishDraft("", true);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closing) {
        const prompt = queue.shift()!;
        patchEntry(key, { busy: true, draftText: null, draftUpdatedAt: null });
        try {
          await runTurn(prompt);
        } finally {
          patchEntry(key, { busy: false, draftText: null, draftUpdatedAt: null });
        }
      }
    } finally {
      draining = false;
    }
  }

  function interrupt(): void {
    aborting = true;
    void client.abort().catch(() => {});
  }

  function shutdown(): void {
    closing = true;
    void client.abort().catch(() => {});
    removeEntry(key);
    void client.stop().finally(() => process.exit(0));
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") {
      if (cmd.text.trim()) {
        queue.push(cmd.text);
        void drain();
      }
    } else if (cmd.type === "interrupt") {
      interrupt();
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by byte offset — same polling approach as the other
  // harnesses (simple + reliable across filesystems; 250ms is interactive).
  const cmdFile = cmdPath(key);
  let cmdOffset = 0;
  try { cmdOffset = statSync(cmdFile).size; } catch {}
  const poll = setInterval(() => {
    let raw = "";
    try {
      raw = readFileSync(cmdFile, "utf8");
    } catch {
      return; // not created yet
    }
    if (raw.length <= cmdOffset) {
      if (raw.length < cmdOffset) cmdOffset = 0; // truncated/rotated
      return;
    }
    const fresh = raw.slice(cmdOffset);
    cmdOffset = raw.length;
    for (const line of fresh.split("\n")) {
      if (!line.trim()) continue;
      try {
        dispatch(JSON.parse(line) as AisdkCommand);
      } catch {}
    }
  }, 250);

  // First message, if any, kicks off the conversation immediately.
  if (initialPrompt) {
    queue.push(initialPrompt);
    void drain();
  }

  // Keep the process alive on the poll timer; resolve only on shutdown.
  await new Promise<void>((resolve) => {
    const exitWatch = setInterval(() => {
      if (closing) {
        clearInterval(poll);
        clearInterval(exitWatch);
        resolve();
      }
    }, 100);
  });
}

// Run directly: `bun src/agents/backends/pi-session.ts --key <uuid> ...`.
// Spawned standalone by spawnManagedPiSession (not via the lfg CLI) so the
// harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdPiSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
