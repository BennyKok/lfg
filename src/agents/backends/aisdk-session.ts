// Headless interactive session harness for the "aisdk" agent kind.
//
// This is the long-lived process behind a "claude code (ai sdk)" session. It runs
// inside a tmux pane (the pane is only a process supervisor + lifecycle handle —
// we never drive I/O through it), and drives a multi-turn conversation through the
// Vercel AI SDK + the ai-sdk-provider-claude-code provider, the same harness the
// one-shot report backend uses (see ./claude-ai-sdk.ts).
//
// Parity with the tmux claude/codex sessions is achieved WITHOUT reusing the
// tmux send-keys machinery:
//   - transcript OUT: the provider (persistSession on by default) writes the
//     standard JSONL to ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl, which the
//     existing live-view discovery + SSE stream read unchanged.
//   - control IN: we tail a command file (data/aisdk/<sessionId>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<sessionId>.json) that we
//     keep updated; serve reads it for the live-view busy dot and session list.
//
// Interrupt is an AbortController on the current turn — staying purely on the AI
// SDK surface rather than reaching into the underlying Query.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import { ensureChatTranscriptCaughtUp } from "../../chat-ingest.ts";
import { resolveTranscript } from "../../sessions.ts";
import { makeDraftPublisher } from "./draft.ts";
import { readFileSync } from "node:fs";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Map lfg's shared thinking-level vocabulary onto the claude-code provider's
// `effort` option (low|medium|high|xhigh|max). Mirrors claudeEffortFor in
// tmux.ts; duplicated here to keep this harness free of the heavier tmux/serve
// dependency graph. Undefined → provider default effort.
function effortFor(level?: string): string | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "minimal") return "low";
  if (["low", "medium", "high", "xhigh", "max"].includes(level)) return level;
  return undefined;
}

function resolveClaudePath(): string | undefined {
  try {
    return process.env.LFG_CLAUDE_PATH ?? Bun.which("claude") ?? undefined;
  } catch {
    return undefined;
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
  const { streamText } = await import("ai");
  const { claudeCode } = await import("ai-sdk-provider-claude-code");

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
  // Best-effort inline indexing only — never gate the session on it. If the
  // transcript path can't be resolved, run normally and let the serve monitor
  // backfill; do NOT exit.
  const transcriptPath = await resolveTranscript(sessionId);
  if (!transcriptPath) {
    console.error(
      `aisdk-session: transcript path unresolved for ${sessionId}; inline indexing disabled (monitor will backfill)`,
    );
  }

  const queue: string[] = [];
  let startedOnce = false; // turn 1 sets the session id; later turns resume it
  let currentAc: AbortController | null = null;
  let draining = false;
  let closing = false;

  const publishDraft = makeDraftPublisher(sessionId);
  const catchUpTranscript = () => {
    if (!transcriptPath) return;
    void ensureChatTranscriptCaughtUp(transcriptPath, sessionId, "aisdk-stream").catch(() => {});
  };

  async function runTurn(prompt: string, signal: AbortSignal): Promise<void> {
    const first = !startedOnce;
    startedOnce = true;
    // The provider/CLI rejects `sessionId` together with `resume` — so set the
    // deterministic id only on the first turn, and resume it thereafter.
    const llm = claudeCode(model, {
      ...(first ? { sessionId } : { resume: sessionId }),
      // Full capability + no permission prompts, mirroring the tmux claude's
      // --dangerously-skip-permissions. settingSources honors ~/.claude config
      // (and loads filesystem skills).
      permissionMode: "bypassPermissions",
      // This headless/paneless harness can't render or answer an interactive
      // question, and bypassPermissions does NOT auto-resolve AskUserQuestion —
      // the CLI's permission resolver returns behavior:"ask" for it BEFORE the
      // bypass auto-allow branch (it's exempted), so without this the turn would
      // hang busy forever waiting on an answer that can never arrive. Disallowing
      // the tool forces the agent to decide for itself instead of asking. Safe
      // because this harness sets NO allowedTools (allowedTools/disallowedTools
      // are mutually exclusive in the provider).
      disallowedTools: ["AskUserQuestion"],
      settingSources: ["user", "project"],
      // Thinking mode: pin the reasoning effort when the caller asked for one.
      // The claude-code provider accepts `effort` (low|medium|high|xhigh|max);
      // omitting it inherits the provider/model default.
      ...(effort ? { effort } : {}),
      // The provider builds the claude subprocess env from a sanitizing
      // allowlist (HOME/PATH/ANTHROPIC_*/CLAUDE_*/…) — LFG_* is NOT on it, so
      // without this the `lfg mcp` server under claude loses LFG_SESSION_ID/
      // LFG_USER and every lfg_create_subagent child lands unlinked (no
      // parent) and unassigned (no user). Forward all LFG_* vars explicitly.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k.startsWith("LFG_")),
      ),
      ...(claudePath
        ? { sdkOptions: { pathToClaudeCodeExecutable: claudePath } }
        : {}),
    } as any);

    const result = streamText({ model: llm, prompt, abortSignal: signal });
    try {
      let draft = "";
      publishDraft("", true);
      for await (const part of result.fullStream as any) {
        if (part?.type === "text-delta") {
          const delta = String(part.text ?? part.textDelta ?? part.delta ?? "");
          if (delta) {
            draft += delta;
            publishDraft(draft);
          }
        } else if (part?.type === "error") {
          throw new Error(String((part as any).error).slice(0, 800));
        } else if (
          part?.type === "finish" ||
          part?.type === "step-finish" ||
          part?.type === "finish-step"
        ) {
          catchUpTranscript();
        }
      }
      publishDraft(draft, true);
      await result.text; // surfaces a failed generation
      catchUpTranscript();
    } catch (e) {
      if (signal.aborted) return; // interrupted on purpose — not an error
      console.error(`aisdk-session turn failed: ${e instanceof Error ? e.message : e}`);
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
        patchEntry(sessionId, { busy: true, draftText: null, draftUpdatedAt: null });
        try {
          await runTurn(prompt, currentAc.signal);
        } finally {
          currentAc = null;
          patchEntry(sessionId, { busy: false, draftText: null, draftUpdatedAt: null });
        }
      }
    } finally {
      draining = false;
    }
  }

  function shutdown(): void {
    closing = true;
    currentAc?.abort();
    removeEntry(sessionId);
    // Give the registry write a tick to flush, then exit so the tmux pane closes.
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

  // Tail the command file by byte offset. Polling (vs fs.watch) is simpler and
  // reliable across editors/filesystems; 250ms is well within interactive feel.
  const cmdFile = cmdPath(sessionId);
  let cmdOffset = 0;
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

// Run directly: `bun src/agents/backends/aisdk-session.ts --session <uuid> ...`.
// Spawned standalone by spawnManagedAisdkSession (not via the lfg CLI) so the
// harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdAisdkSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
