// Headless interactive session harness for the "codex-aisdk" agent kind.
//
// This is the long-lived process behind a managed codex session. Like its
// Claude sibling (./aisdk-session.ts) it runs inside a tmux pane used purely as
// a process supervisor + lifecycle handle (we never drive I/O through the pane),
// and drives a multi-turn conversation through the OFFICIAL @openai/codex-sdk
// (`Codex` → `startThread`/`resumeThread` → `runStreamed`). ChatGPT-subscription
// auth comes from ~/.codex/auth.json; there is NO API key.
//
// History: this harness previously went through the Vercel AI SDK
// (ai-sdk-provider-codex-cli app-server provider). The official SDK removes the
// adapter's contortions: `thread.started` reports the thread id the moment the
// first turn starts (the old path learned it via onSessionCreated + resolved
// providerMetadata after the turn), and turns take a plain AbortSignal.
//
// Control plane is identical to the Claude harness:
//   - control IN: we tail a command file (data/aisdk/<key>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//
// We mint a control-plane KEY (a uuid) up front for the registry/command files.
// Codex still reports its own threadId for SDK resume, but lfg indexes the SDK
// stream directly under the control-plane key instead of reading rollout JSONL.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import type { SessionMsg } from "../../sessions.ts";
import { indexSessionMessagesDirect, reindexFileHistoryUnderSessionKey } from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Only an EXPLICIT override redirects the SDK away from its bundled codex
// binary. The SDK pins a matching @openai/codex dependency (protocol-tested
// pairing); pointing it at an older global CLI risks a protocol mismatch, so —
// unlike the old provider — we no longer prefer the global binary by default.
function resolveCodexPathOverride(): string | undefined {
  const explicit = process.env.LFG_CODEX_PATH;
  if (!explicit) return undefined;
  try {
    const real = realpathSync(explicit);
    return existsSync(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

// Shared thread options for both the interactive harness and the one-shot
// runner: full access + never-approve mirrors the tmux codex session's
// `--sandbox danger-full-access --ask-for-approval never`.
function threadOptions(model: string, cwd: string, thinkingLevel?: string) {
  return {
    model,
    workingDirectory: cwd,
    sandboxMode: "danger-full-access" as const,
    approvalPolicy: "never" as const,
    // Managed worktrees live under /tmp — codex refuses non-git dirs otherwise.
    skipGitRepoCheck: true,
    ...(thinkingLevel
      ? { modelReasoningEffort: thinkingLevel as "low" | "medium" | "high" }
      : {}),
  };
}

function compactText(value: string, max = 8_000): string {
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${value.slice(0, head)}\n\n...[${value.length - head - tail} chars omitted]...\n\n${value.slice(-tail)}`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function codexCompletedItemMessage(item: Record<string, unknown>, turnNonce: string): SessionMsg | null {
  // Codex item ids are per-turn counters ("item_0", "item_1", …) that RESET
  // every turn. The direct index dedupes rows by message id, so without a
  // per-turn nonce every message of turn 2+ collided with turn 1's ids and
  // was silently dropped (INSERT OR IGNORE) — the session answered but the
  // transcript never showed it. The nonce is minted once per runTurn, so
  // re-emitted item.completed events within a turn still dedupe correctly.
  const rawId = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
  const id = `${turnNonce}/${rawId}`;
  const type = typeof item.type === "string" ? item.type : "item";
  const ts = Date.now();
  if (type === "agent_message") {
    const text = typeof item.text === "string" ? item.text.trim() : "";
    return text ? { id, role: "assistant", kind: "text", text, ts } : null;
  }
  if (type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "";
    const output = stringifyValue(item.output ?? item.stdout ?? item.stderr).trim();
    const text = compactText([command ? `$ ${command}` : "command_execution", output].filter(Boolean).join("\n"));
    return { id, role: "assistant", kind: "tool_use", text, ts };
  }
  if (type === "web_search") {
    const query = typeof item.query === "string" ? item.query : "";
    const result = stringifyValue(item.results ?? item.result ?? item.output).trim();
    const text = compactText([query ? `web_search: ${query}` : "web_search", result].filter(Boolean).join("\n"));
    return { id, role: "assistant", kind: "tool_use", text, ts };
  }
  if (type === "file_change") {
    const path = typeof item.path === "string" ? item.path : "";
    const text = compactText([path ? `file_change: ${path}` : "file_change", stringifyValue(item).trim()].filter(Boolean).join("\n"));
    return { id, role: "assistant", kind: "tool_use", text, ts };
  }
  if (type === "reasoning") {
    const text = stringifyValue(item.summary ?? item.text).trim();
    return text ? { id, role: "assistant", kind: "thinking", text: compactText(text), ts } : null;
  }
  if (type === "error") {
    // Surface codex error items (e.g. "Model metadata for `X` not found") as a
    // readable assistant error line, not a raw tool_result JSON blob. apiError
    // marks it as a genuine upstream failure for status classification.
    const msg = (typeof item.message === "string" ? item.message : stringifyValue(item)).trim();
    return msg
      ? { id, role: "assistant", kind: "text", text: `⚠️ Codex error: ${msg}`, ts, apiError: true }
      : null;
  }
  const text = compactText([type, stringifyValue(item).trim()].filter(Boolean).join("\n"));
  return text.trim() ? { id, role: "tool", kind: "tool_result", text, ts } : null;
}

// One-shot headless run for the auto/report runner: single thread, single turn.
export async function pipeToCodexAiSdk(
  prompt: string,
  log: (s: string) => void,
  opts: { model?: string; thinkingLevel?: string; cwd?: string } = {},
): Promise<string> {
  const model = opts.model ?? "gpt-5.5";
  const cwd = opts.cwd ?? process.cwd();
  const { Codex } = await import("@openai/codex-sdk");
  const codexPathOverride = resolveCodexPathOverride();
  const codex = new Codex(codexPathOverride ? { codexPathOverride } : {});

  log(`[runner] piping ${prompt.length} chars to codex via codex-sdk (${model})`);
  const thread = codex.startThread(threadOptions(model, cwd, opts.thinkingLevel));
  const { events } = await thread.runStreamed(prompt);
  let text = "";
  let chars = 0;
  let lastEmit = 0;
  const flush = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit > 800) {
      lastEmit = now;
      const k = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : String(chars);
      log(`[runner] codex generating… ${k} chars`);
    }
  };
  for await (const event of events) {
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      text += (text ? "\n\n" : "") + event.item.text;
      chars = text.length;
      flush();
    } else if (event.type === "item.started" && event.item.type === "command_execution") {
      log(`[runner] codex running: ${(event.item as { command?: string }).command ?? "?"}`);
    } else if (event.type === "turn.failed") {
      throw new Error(String(event.error?.message ?? "codex turn failed").slice(0, 800));
    } else if (event.type === "error") {
      throw new Error(String(event.message ?? "codex thread error").slice(0, 800));
    }
  }
  flush(true);
  if (!text.trim()) throw new Error("codex sdk backend produced empty result");
  log(`[runner] codex sdk done (${text.length} chars)`);
  return text;
}

export async function cmdCodexAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files. NOT the
  // codex thread id (which we learn at thread.started on turn 1).
  const keyArg = arg(argv, "--key");
  const model = arg(argv, "--model") ?? "gpt-5.5";
  const thinkingLevel = arg(argv, "--thinking-level");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  // Resuming a closed codex session: the rollout's threadId is known up front.
  const resumeThreadId = arg(argv, "--resume");
  // Everything after `--` is the initial prompt.
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!keyArg) {
    console.error("codex-aisdk-session: --key <uuid> is required");
    process.exit(1);
  }
  const key: string = keyArg;

  try {
    process.chdir(cwd);
  } catch {}

  // Resuming a codex thread under a fresh control-plane key: the thread's history
  // was tailed into the index under its native threadId, so the pane keyed by
  // `key` would render empty. Seed the synthetic key from the threadId's history
  // (no-op if the key already has rows or the thread has none) — visible history
  // now, new turns append after it. See reindexFileHistoryUnderSessionKey.
  if (resumeThreadId && resumeThreadId !== key) {
    reindexFileHistoryUnderSessionKey(key, resumeThreadId);
  }

  const { Codex } = await import("@openai/codex-sdk");
  const codexPathOverride = resolveCodexPathOverride();
  // Omitting `env` inherits process.env (HOME → ~/.codex auth, LFG_* for MCP).
  const codex = new Codex(codexPathOverride ? { codexPathOverride } : {});
  const opts = threadOptions(model, cwd, thinkingLevel ?? undefined);
  const thread = resumeThreadId
    ? codex.resumeThread(resumeThreadId, opts)
    : codex.startThread(opts);

  let threadId: string | null = resumeThreadId ?? null;

  // Control-plane registry entry — the moment this exists (and our pid is
  // alive), serve surfaces the session in the live view. threadId starts null
  // on fresh sessions and is patched at turn 1's thread.started event.
  writeEntry({
    sessionId: key,
    agent: "codex",
    threadId,
    harnessPid: process.pid,
    tmuxName,
    cwd,
    model,
    busy: false,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  const queue: string[] = [];
  let currentAc: AbortController | null = null;
  let draining = false;
  let closing = false;

  const publishDraft = makeDraftPublisher(key);

  async function runTurn(prompt: string, signal: AbortSignal): Promise<void> {
    // Codex turns are explicit request/response — no streaming-input merge —
    // so per-turn busy handling in drain() below cannot drift.
    // Unique per turn AND per harness process, so item_N ids never collide
    // across turns or across a restart that resumes the same session.
    const turnNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    indexSessionMessagesDirect(key, [
      { id: crypto.randomUUID(), role: "user", kind: "text", text: prompt, ts: Date.now() },
    ]);
    try {
      const { events } = await thread.runStreamed(prompt, { signal });
      publishDraft("", true);
      for await (const event of events) {
        if (event.type === "thread.started") {
          if (event.thread_id && event.thread_id !== threadId) {
            threadId = event.thread_id;
            patchEntry(key, { threadId });
          }
        } else if (
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.item.type === "agent_message"
        ) {
          // The draft is only the in-progress message. Completed items are
          // indexed directly (and published as real msg frames), so keeping
          // them in the draft — as the JSONL-lag era code did — would render
          // an ever-growing blob duplicating the finalized messages.
          if (event.type === "item.completed") {
            const message = codexCompletedItemMessage(event.item as Record<string, unknown>, turnNonce);
            if (message) indexSessionMessagesDirect(key, [message]);
            publishDraft("", true);
          } else if (event.item.text) {
            publishDraft(event.item.text);
          }
        } else if (event.type === "item.completed") {
          const message = codexCompletedItemMessage(event.item as Record<string, unknown>, turnNonce);
          if (message) indexSessionMessagesDirect(key, [message]);
        } else if (event.type === "turn.failed") {
          throw new Error(String(event.error?.message ?? "turn failed").slice(0, 800));
        } else if (event.type === "error") {
          throw new Error(String(event.message ?? "thread error").slice(0, 800));
        }
      }
    } catch (e) {
      if (signal.aborted) return; // interrupted on purpose — not an error
      const msg = (e instanceof Error ? e.message : String(e)).trim() || "unknown error";
      console.error(`codex-aisdk-session turn failed: ${msg}`);
      // Surface the failure in the transcript — a turn that dies silently
      // (turn.failed, thread error, SDK crash) otherwise leaves the user
      // staring at a session that just "stopped" with no visible reason.
      indexSessionMessagesDirect(key, [
        {
          id: `${turnNonce}/turn_failed`,
          role: "assistant",
          kind: "text",
          text: `⚠️ Codex turn failed: ${msg.slice(0, 800)}`,
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
        currentAc = new AbortController();
        patchEntry(key, { busy: true, draftText: null, draftUpdatedAt: null });
        try {
          await runTurn(prompt, currentAc.signal);
        } finally {
          currentAc = null;
          patchEntry(key, { busy: false, draftText: null, draftUpdatedAt: null });
        }
      }
    } finally {
      draining = false;
    }
  }

  function shutdown(): void {
    closing = true;
    currentAc?.abort();
    removeEntry(key);
    // Give the registry write a tick to flush, then exit so the tmux pane
    // closes (the SDK's codex child exits with us).
    setTimeout(() => process.exit(0), 50);
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") {
      if (cmd.text.trim()) {
        queue.push(cmd.text);
        void drain();
      }
    } else if (cmd.type === "interrupt") {
      currentAc?.abort();
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by byte offset — same polling approach as the Claude
  // harness (simple + reliable across filesystems; 250ms is interactive enough).
  const cmdFile = cmdPath(key);
  let cmdOffset = 0;
  // Start tailing from the CURRENT end of the command file. Commands before
  // this process started belong to a previous harness incarnation — replaying
  // them on restart would re-send every historical message as a new turn.
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

// Run directly: `bun src/agents/backends/codex-aisdk-session.ts --key <uuid> ...`.
// Spawned standalone by spawnManagedCodexAisdkSession (not via the lfg CLI) so
// the harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdCodexAisdkSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
