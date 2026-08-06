// Headless interactive session harness for the "aisdk" agent kind.
//
// This is the long-lived process behind a "claude code" managed session. It runs
// as a detached process and drives a multi-turn conversation through the
// OFFICIAL @anthropic-ai/claude-agent-sdk (`query()` with streaming input) — one
// live claude subprocess for the whole session, no per-turn resume dance.
//
// History: this harness previously went through the Vercel AI SDK
// (`streamText` + ai-sdk-provider-claude-code). That adapter wrapped this same
// Agent SDK but hid its session surface — no permission callbacks (the
// AskUserQuestion hang), no first-hand message stream (transcripts had to be
// re-discovered from ~/.claude/projects JSONL), version-locked to ai@6. Going
// direct removes the middle layer while keeping the exact same external
// contract, so serve and the web UI are unchanged:
//   - transcript OUT: SDK messages are indexed directly into SQLite under the
//     synthetic lfg:// session key. The Agent SDK's private JSONL may still
//     exist for its own resume machinery, but lfg does not read or write it.
//   - control IN: we tail a command file (data/aisdk/<sessionId>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<sessionId>.json) that we
//     keep updated; serve reads it for the live-view busy dot and session list.
//
// Interrupt is the SDK's native `query.interrupt()` — it stops the current turn
// without killing the session process.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
  currentBootId,
} from "../../aisdk-registry.ts";
import { normalizeLineMessages, type SessionMsg } from "../../sessions.ts";
import { sessionTitleFromPrompt } from "../../lfg-capabilities.ts";
import {
  indexSessionMessagesDirect,
  reindexFileHistoryUnderSessionKey,
  sessionHasIndexedMessages,
} from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { readFileSync, statSync } from "node:fs";
import { initialCmdOffset, readNewCmdLines, writeCursor } from "./cmd-tail.ts";
import { claudeAccountEnv } from "../../claude-creds.ts";
import { lfgMcpServers } from "../../config.ts";
import {
  claudeAccountConfigDir,
  resolveClaudeAccount,
} from "../../claude-accounts.ts";
import {
  readStoredSessionTokenUsage,
  writeStoredSessionTokenUsage,
  type ClaudeContextUsageSnapshot,
} from "../../session-token-usage.ts";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Map lfg's shared thinking-level vocabulary onto the Agent SDK's `effort`
// option (low|medium|high|xhigh|max). Mirrors claudeEffortFor in tmux.ts;
// duplicated here to keep this harness free of the heavier tmux/serve
// dependency graph. Undefined → SDK/model default effort.
function effortFor(level?: string): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "minimal") return "low";
  if (["low", "medium", "high", "xhigh", "max"].includes(level)) {
    return level as "low" | "medium" | "high" | "xhigh" | "max";
  }
  return undefined;
}

function resolveClaudePath(): string | undefined {
  try {
    return process.env.LFG_CLAUDE_PATH ?? Bun.which("claude") ?? undefined;
  } catch {
    return undefined;
  }
}

function sdkMessageIdentity(msg: Record<string, unknown>): string | null {
  const message = msg.message as Record<string, unknown> | undefined;
  const id = msg.uuid ?? msg.id ?? message?.uuid ?? message?.id;
  return typeof id === "string" && id ? id : null;
}

function normalizeSdkEnvelope(msg: Record<string, unknown>): SessionMsg[] {
  const id = sdkMessageIdentity(msg);
  const envelope = { ...msg } as Record<string, unknown>;
  if (!envelope.uuid && id) envelope.uuid = id;
  const now = Date.now();
  const fallbackId =
    id ??
    `${String(msg.type ?? "message")}:${String(envelope.timestamp ?? now)}:${JSON.stringify(msg.message ?? msg).slice(0, 200)}`;
  return normalizeLineMessages(JSON.stringify(envelope)).map((message, index) => ({
    ...message,
    id: message.id ?? (index === 0 ? fallbackId : `${fallbackId}#${index}`),
    ts: message.ts ?? now,
  }));
}

function userTextMessage(text: string): SessionMsg {
  return { id: crypto.randomUUID(), role: "user", kind: "text", text, ts: Date.now() };
}

/**
 * Human-readable detail for a non-success Agent SDK `result` message.
 *
 * This used to be `String(msg.result ?? msg.subtype)`, which reported nothing
 * but `"error_during_execution"` — three sessions died that way on 2026-08-06
 * with no recoverable reason. The cause is that `result` exists only on
 * SDKResultSuccess; the ERROR variant (SDKResultError) has no such field, so
 * the `??` always fell through to the bare subtype. Everything that explains
 * the failure lives in fields the old line never read:
 *
 *   errors[]           the actual messages
 *   terminal_reason    prompt_too_long / api_error / model_error / blocking_limit / …
 *   stop_reason        why the turn stopped
 *   permission_denials a turn can end simply because a tool was refused
 *
 * Defensive about shapes on purpose: this runs on the failure path, where a
 * throw would destroy the very diagnostic we're trying to emit.
 */
export function describeAisdkFailure(msg: Record<string, unknown>): string {
  const parts: string[] = [typeof msg.subtype === "string" ? msg.subtype : "unknown"];
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const terminal = str(msg.terminal_reason);
  if (terminal) parts.push(`terminal_reason=${terminal}`);
  const stop = str(msg.stop_reason);
  if (stop) parts.push(`stop_reason=${stop}`);

  const errors = (Array.isArray(msg.errors) ? msg.errors : [])
    .map((e) => str(e) ?? (e == null ? null : safeJson(e)))
    .filter((e): e is string => !!e);
  if (errors.length) parts.push(`errors=[${errors.join("; ")}]`);

  const denials = Array.isArray(msg.permission_denials) ? msg.permission_denials : [];
  if (denials.length) {
    const tools = [
      ...new Set(
        denials
          .map((d) => (d && typeof d === "object" ? str((d as Record<string, unknown>).tool_name) : null))
          .filter((t): t is string => !!t),
      ),
    ];
    parts.push(`permission_denials=${denials.length}${tools.length ? ` (${tools.join(", ")})` : ""}`);
  }

  // Only the success variant carries `result` today, but read it anyway: the
  // SDK has moved this field before, and an unexpected one is still a clue.
  const legacy = str(msg.result) ?? (msg.result && typeof msg.result === "object" ? safeJson(msg.result) : null);
  if (legacy) parts.push(`result=${legacy}`);

  if (typeof msg.num_turns === "number") parts.push(`num_turns=${msg.num_turns}`);
  if (typeof msg.duration_ms === "number") parts.push(`duration_ms=${msg.duration_ms}`);
  return parts.join(" ");
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null; // circular / non-serializable — better a missing field than a throw
  }
}

// Minimal push-driven AsyncIterable — the Agent SDK's streaming-input mode
// consumes this; serve-side sends are pushed in as they arrive on the cmd file.
type UserMsg = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
};

class InputChannel implements AsyncIterable<UserMsg> {
  private buffer: UserMsg[] = [];
  private waiter: ((v: IteratorResult<UserMsg>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    const msg: UserMsg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<UserMsg> {
    return {
      next: (): Promise<IteratorResult<UserMsg>> => {
        if (this.buffer.length) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export async function cmdAisdkSession(argv: string[]): Promise<void> {
  const sessionIdArg = arg(argv, "--session");
  const model = arg(argv, "--model") ?? "opus";
  const effort = effortFor(arg(argv, "--thinking-level"));
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--managed-name") ?? arg(argv, "--tmux") ?? "";
  const recoveredAt = Number(arg(argv, "--recovered-at")) || null;
  const claudeAccountId = arg(argv, "--claude-account");
  // Everything after `--` is the initial prompt (mirrors how spawnManagedSession
  // passes the first message to the claude CLI).
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!sessionIdArg) {
    console.error("aisdk-session: --session <uuid> is required");
    process.exit(1);
  }
  const sessionId: string = sessionIdArg;

  try {
    process.chdir(cwd);
  } catch {}

  const claudePath = resolveClaudePath();
  const account = resolveClaudeAccount(claudeAccountId);
  const accountConfigDir = account ? claudeAccountConfigDir(account.id) : null;
  const accountEnv = claudeAccountEnv(
    process.env,
    !!account,
    accountConfigDir ?? undefined,
  );
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Control-plane registry entry — the moment this exists (and our pid is alive),
  // serve will surface the session in the live view.
  const bootId = currentBootId();
  writeEntry({
    sessionId,
    agent: "claude",
    harnessPid: process.pid,
    tmuxName,
    supervisor: "process",
    bootId,
    recoveryClaimBootId: recoveredAt ? bootId : null,
    recoveredAt,
    thinkingLevel: arg(argv, "--thinking-level") ?? null,
    cwd,
    model,
    busy: false,
    title: sessionTitleFromPrompt(initialPrompt),
    createdAt: Date.now(),
  });

  // Direct-indexed rows for this id mean we're a relaunched harness continuing
  // an existing session. Fresh sessions mint the deterministic id up front
  // (sessionId and resume are mutually exclusive on the SDK).
  const resuming = sessionHasIndexedMessages(sessionId);
  // Legacy claude sessions have their history under a native ~/.claude JSONL
  // file path, not the synthetic session key — so a resumed pane would render
  // empty. Seed the synthetic key from that file history so the transcript is
  // visible and new turns append to it. Done AFTER `resuming` is captured, so
  // the SDK still starts in `{ sessionId }` mode (no resume of an id the SDK
  // never minted) — visibility now, continuation as a fresh underlying thread.
  if (!resuming) reindexFileHistoryUnderSessionKey(sessionId);

  const publishDraft = makeDraftPublisher(sessionId);

  const input = new InputChannel();
  let closing = false;
  let draft = "";
  let busy = false;
  const previousUsage = readStoredSessionTokenUsage(sessionId);
  let sessionTotals = previousUsage?.totals ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    costUsd: 0,
  };
  let contextUsage = previousUsage?.context ?? null;
  let usageRefresh = 0;

  const persistUsage = () => {
    writeStoredSessionTokenUsage(sessionId, {
      updatedAt: Date.now(),
      model,
      context: contextUsage,
      totals: sessionTotals,
    });
  };

  const refreshUsageSnapshot = () => {
    const request = ++usageRefresh;
    void Promise.allSettled([
      q.getContextUsage(),
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ])
      .then(([contextResult, totalsResult]) => {
        if (request !== usageRefresh) return;
        if (contextResult.status === "fulfilled") {
          contextUsage = contextResult.value as ClaudeContextUsageSnapshot;
        }
        if (totalsResult.status === "fulfilled") {
          const reported = totalsResult.value.session;
          const modelTotals = Object.values(reported.model_usage);
          const input = modelTotals.reduce((sum, row) => sum + row.inputTokens, 0);
          const output = modelTotals.reduce((sum, row) => sum + row.outputTokens, 0);
          const cacheRead = modelTotals.reduce((sum, row) => sum + row.cacheReadInputTokens, 0);
          const cacheWrite = modelTotals.reduce(
            (sum, row) => sum + row.cacheCreationInputTokens,
            0,
          );
          sessionTotals = {
            input,
            output,
            cacheRead,
            cacheWrite,
            reasoning: 0,
            total: input + output + cacheRead + cacheWrite,
            costUsd: reported.total_cost_usd,
          };
        }
        persistUsage();
      })
      .catch(() => {});
  };

  // Busy is ACTIVITY-DRIVEN, not turn-counted. The SDK's streaming input may
  // merge a queued/steering send into the running turn, so `result` events do
  // not correspond 1:1 with sends — a counter drifts and the busy dot sticks.
  // Instead: any send or assistant activity marks busy, any turn result clears
  // it, and if the CLI immediately starts another turn for a queued message the
  // next stream event flips it right back. Self-healing in every ordering.
  const setBusy = (next: boolean) => {
    if (busy === next) return;
    busy = next;
    patchEntry(sessionId, next ? { busy: true } : { busy: false, draftText: null, draftUpdatedAt: null });
  };

  const q = query({
    prompt: input as AsyncIterable<never>,
    options: {
      model,
      cwd,
      ...(resuming ? { resume: sessionId } : { sessionId }),
      // Full capability + no permission prompts, mirroring the tmux claude's
      // --dangerously-skip-permissions. settingSources honors ~/.claude config
      // (and loads filesystem skills).
      permissionMode: "bypassPermissions",
      // This headless/paneless harness can't render or answer an interactive
      // question, and bypassPermissions does NOT auto-resolve AskUserQuestion —
      // the CLI's permission resolver returns behavior:"ask" for it BEFORE the
      // bypass auto-allow branch, so without this a turn would hang busy
      // forever. Disallowing the tool forces the agent to decide for itself.
      // (The Agent SDK's canUseTool callback is the future path to answering
      // these from the dashboard instead.)
      disallowedTools: ["AskUserQuestion"],
      settingSources: ["user", "project"],
      // Re-register the LFG MCP endpoint under this session's own URL. The
      // user-scope registration settingSources loads is session-agnostic — one
      // config serves every session — so without this the shared serve process
      // cannot tell who is calling, and every session-scoped tool
      // (lfg_display_image, lfg_input, lfg_publish_artifact, …) fails.
      ...lfgMcpServers(sessionId),
      // stream_event partial messages drive the live draft in the web UI.
      includePartialMessages: true,
      ...(effort ? { effort } : {}),
      // env is a FULL replacement for the subprocess environment when set —
      // without a connected account, inherit process.env so the platform proxy
      // remains available. With a connected account, keep the full environment
      // except the three platform Anthropic variables that override the user's
      // ~/.claude/.credentials.json. (The old Vercel provider's sanitizing
      // allowlist dropped LFG_* and orphaned every lfg_create_subagent child.)
      ...(accountEnv ? { env: accountEnv } : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    },
  });

  function handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    if (type === "stream_event") {
      setBusy(true);
      // Only the top-level assistant stream feeds the draft; subagent/tool
      // streams carry a parent_tool_use_id.
      if (msg.parent_tool_use_id != null) return;
      const event = msg.event as { type?: string; delta?: { type?: string; text?: string } };
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const delta = event.delta.text ?? "";
        if (delta) {
          draft += delta;
          publishDraft(draft);
        }
      }
      return;
    }
    if (type === "system" && (msg as { subtype?: string }).subtype === "init") {
      return;
    }
    if (type === "assistant" || type === "user") {
      setBusy(true);
      const messages = normalizeSdkEnvelope(msg);
      if (messages.length) indexSessionMessagesDirect(sessionId, messages);
      // A finalized assistant message supersedes the streamed draft. Without
      // this reset the draft accumulates EVERY text block of a long multi-tool
      // turn (it only cleared on `result`), so the live view rendered one
      // ever-growing blob duplicating the already-indexed messages.
      if (type === "assistant" && messages.some((m) => m.kind === "text") && draft) {
        draft = "";
        publishDraft("", true);
      }
      return;
    }
    if (type === "result") {
      const result = msg as {
        usage?: Record<string, unknown>;
        total_cost_usd?: number;
      };
      const usage = result.usage;
      if (usage) {
        const input = Number(usage.input_tokens) || 0;
        const output = Number(usage.output_tokens) || 0;
        const cacheRead = Number(usage.cache_read_input_tokens) || 0;
        const cacheWrite = Number(usage.cache_creation_input_tokens) || 0;
        sessionTotals.input += input;
        sessionTotals.output += output;
        sessionTotals.cacheRead += cacheRead;
        sessionTotals.cacheWrite += cacheWrite;
        sessionTotals.total += input + output + cacheRead + cacheWrite;
        sessionTotals.costUsd = (sessionTotals.costUsd ?? 0) + (Number(result.total_cost_usd) || 0);
        persistUsage();
        refreshUsageSnapshot();
      }
      if ((msg as { subtype?: string }).subtype !== "success") {
        // Every harness logs into the one serve journal, so a line identifying
        // the turn only by pid meant cross-referencing timestamps by hand to
        // find out WHICH session had died. Name it.
        console.error(
          `aisdk-session ${sessionId} turn ended with error: ${describeAisdkFailure(msg).slice(0, 2000)}`,
        );
      }
      draft = "";
      publishDraft("", true);
      setBusy(false);
      return;
    }
  }

  function send(text: string): void {
    draft = "";
    publishDraft("", true);
    setBusy(true);
    indexSessionMessagesDirect(sessionId, [userTextMessage(text)]);
    input.push(text);
  }

  function shutdown(): void {
    if (closing) return;
    closing = true;
    input.close();
    void q.interrupt().catch(() => {});
    // Fallback if the SDK loop doesn't wind down promptly.
    setTimeout(() => {
      removeEntry(sessionId);
      process.exit(0);
    }, 1500);
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") {
      if (cmd.text.trim()) send(cmd.text);
    } else if (cmd.type === "interrupt") {
      void q.interrupt().catch(() => {});
    } else if (cmd.type === "set_thinking_level") {
      const nextEffort = effortFor(cmd.thinkingLevel);
      // The query launch option accepts `max`, but the SDK's documented live
      // Settings layer currently stops at `xhigh`.
      if (!nextEffort || nextEffort === "max") return;
      // Claude's streaming SDK exposes live flag settings on the same process.
      // effortLevel is the setting behind the interactive `/effort` command;
      // applying it here changes subsequent turns without adding a fake chat
      // message or restarting the conversation.
      void q.applyFlagSettings({ effortLevel: nextEffort }).then(() => {
        patchEntry(sessionId, { thinkingLevel: cmd.thinkingLevel });
      }).catch((error) => {
        console.error(`aisdk-session thinking-level change failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by BYTE offset. Polling (vs fs.watch) is simpler and
  // reliable across editors/filesystems; 250ms is well within interactive feel.
  // See cmd-tail.ts for why the arithmetic must stay in bytes — mixing bytes and
  // UTF-16 lengths used to rewind the cursor to 0 and replay the entire command
  // history as new turns.
  const cmdFile = cmdPath(sessionId);
  let cmdOffset = initialCmdOffset(cmdFile);
  writeCursor(cmdFile, cmdOffset);
  const poll = setInterval(() => {
    const { lines, offset } = readNewCmdLines(cmdFile, cmdOffset);
    if (offset === cmdOffset && !lines.length) return;
    cmdOffset = offset;
    for (const line of lines) {
      try {
        dispatch(JSON.parse(line) as AisdkCommand);
      } catch {}
    }
    // Record what we consumed so a restart resumes here rather than re-reading
    // delivered commands or skipping ones queued while this process was down.
    writeCursor(cmdFile, cmdOffset);
  }, 250);

  // First message, if any, kicks off the conversation immediately.
  if (initialPrompt) send(initialPrompt);

  // The SDK message loop IS the session lifetime: it ends when the input
  // channel closes (shutdown) or the subprocess dies.
  try {
    for await (const msg of q) {
      handleMessage(msg as unknown as Record<string, unknown>);
    }
  } catch (e) {
    if (!closing) {
      console.error(`aisdk-session: query loop failed: ${e instanceof Error ? e.message : e}`);
    }
  } finally {
    clearInterval(poll);
    removeEntry(sessionId);
    process.exit(closing ? 0 : 1);
  }
}

// Run directly: `bun src/agents/backends/aisdk-session.ts --session <uuid> ...`.
// Spawned standalone by spawnManagedAisdkSession (not via the lfg CLI) so the
// harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdAisdkSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
