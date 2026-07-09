// Headless interactive session harness for the "aisdk" agent kind.
//
// This is the long-lived process behind a "claude code" managed session. It runs
// inside a tmux pane (the pane is only a process supervisor + lifecycle handle —
// we never drive I/O through it) and drives a multi-turn conversation through the
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
} from "../../aisdk-registry.ts";
import { normalizeLineMessages, type SessionMsg } from "../../sessions.ts";
import { indexSessionMessagesDirect, sessionHasIndexedMessages } from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { readFileSync, statSync } from "node:fs";

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
  const tmuxName = arg(argv, "--tmux") ?? "";
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
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Control-plane registry entry — the moment this exists (and our pid is alive),
  // serve will surface the session in the live view.
  writeEntry({
    sessionId,
    agent: "claude",
    harnessPid: process.pid,
    tmuxName,
    cwd,
    model,
    busy: false,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  // Direct-indexed rows for this id mean we're a relaunched harness continuing
  // an existing session. Fresh sessions mint the deterministic id up front
  // (sessionId and resume are mutually exclusive on the SDK).
  const resuming = sessionHasIndexedMessages(sessionId);

  const publishDraft = makeDraftPublisher(sessionId);

  const input = new InputChannel();
  let closing = false;
  let draft = "";
  let busy = false;

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
      // stream_event partial messages drive the live draft in the web UI.
      includePartialMessages: true,
      ...(effort ? { effort } : {}),
      // env is a FULL replacement for the subprocess environment when set —
      // omitting it inherits all of process.env (PATH/HOME/LFG_*/ANTHROPIC_*),
      // which is exactly what we want. (The old Vercel provider's sanitizing
      // allowlist dropped LFG_* and orphaned every lfg_create_subagent child.)
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
      const errText =
        (msg as { subtype?: string }).subtype !== "success"
          ? String((msg as { result?: unknown }).result ?? (msg as { subtype?: string }).subtype)
          : null;
      if (errText) console.error(`aisdk-session turn ended with error: ${errText.slice(0, 800)}`);
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
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by byte offset. Polling (vs fs.watch) is simpler and
  // reliable across editors/filesystems; 250ms is well within interactive feel.
  const cmdFile = cmdPath(sessionId);
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
