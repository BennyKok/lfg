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
// The id model is unchanged: codex mints the threadId (we learn it at
// thread.started on turn 1) and persists the rollout under ~/.codex/sessions
// named by it. We mint a control-plane KEY (a uuid) up front for the
// registry/command files; the transcript is discovered by
// findCodexTranscriptById once the threadId is known.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import { ensureChatTranscriptCaughtUp } from "../../chat-ingest.ts";
import { makeDraftPublisher } from "./draft.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME ?? homedir();
const CODEX_SESSIONS_DIR = join(HOME, ".codex", "sessions");
const CODEX_ROLLOUT_FILES_CACHE_MS = 800;
const UUID_IN_TEXT =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const UUID_EXACT =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
let codexFilesCache: { at: number; files: string[] } | null = null;
let codexFilesInflight: Promise<string[]> | null = null;
const codexPathById = new Map<string, string>();
const codexMissById = new Map<string, number>();

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

async function codexRolloutFiles(): Promise<string[]> {
  const now = Date.now();
  if (codexFilesCache && now - codexFilesCache.at < CODEX_ROLLOUT_FILES_CACHE_MS) {
    return codexFilesCache.files;
  }
  if (codexFilesInflight) return codexFilesInflight;
  codexFilesInflight = scanCodexRolloutFiles().finally(() => {
    codexFilesInflight = null;
  });
  return codexFilesInflight;
}

async function scanCodexRolloutFiles(): Promise<string[]> {
  const out: string[] = [];
  let years: string[];
  try {
    years = await readdir(CODEX_SESSIONS_DIR);
  } catch {
    return out;
  }
  for (const y of years) {
    let months: string[];
    try {
      months = await readdir(join(CODEX_SESSIONS_DIR, y));
    } catch {
      continue;
    }
    for (const m of months) {
      let days: string[];
      try {
        days = await readdir(join(CODEX_SESSIONS_DIR, y, m));
      } catch {
        continue;
      }
      for (const d of days) {
        let files: string[];
        try {
          files = await readdir(join(CODEX_SESSIONS_DIR, y, m, d));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const path = join(CODEX_SESSIONS_DIR, y, m, d, f);
          out.push(path);
          const id = path.match(UUID_IN_TEXT)?.[0];
          if (id) {
            codexPathById.set(id, path);
            codexMissById.delete(id);
          }
        }
      }
    }
  }
  codexFilesCache = { at: Date.now(), files: out };
  return out;
}

async function findCodexTranscriptById(id: string): Promise<string | null> {
  if (!UUID_EXACT.test(id)) return null;
  const hit = codexPathById.get(id);
  if (hit) return hit;
  const missAt = codexMissById.get(id);
  if (missAt && Date.now() - missAt < CODEX_ROLLOUT_FILES_CACHE_MS) return null;
  await codexRolloutFiles();
  const found = codexPathById.get(id) ?? null;
  if (!found) codexMissById.set(id, Date.now());
  return found;
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

  const { Codex } = await import("@openai/codex-sdk");
  const codexPathOverride = resolveCodexPathOverride();
  // Omitting `env` inherits process.env (HOME → ~/.codex auth, LFG_* for MCP).
  const codex = new Codex(codexPathOverride ? { codexPathOverride } : {});
  const opts = threadOptions(model, cwd, thinkingLevel ?? undefined);
  const thread = resumeThreadId
    ? codex.resumeThread(resumeThreadId, opts)
    : codex.startThread(opts);

  let threadId: string | null = resumeThreadId ?? null;
  let transcriptPath: string | null = null;
  let transcriptPathInflight: Promise<string | null> | null = null;

  function triggerTranscriptCatchUp(): void {
    const id = threadId;
    if (!id) return;
    void (async () => {
      let path = transcriptPath;
      if (!path) {
        transcriptPathInflight ??= findCodexTranscriptById(id).finally(() => {
          transcriptPathInflight = null;
        });
        path = await transcriptPathInflight;
      }
      if (!path) return;
      transcriptPath = path;
      // sessionId MUST be the LFG key (what the serve monitor + search use);
      // threadId is discovery-only.
      await ensureChatTranscriptCaughtUp(path, key, "codex-aisdk-stream");
    })().catch(() => {});
  }

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
    try {
      const { events } = await thread.runStreamed(prompt, { signal });
      let completed = ""; // text of finished agent_message items this turn
      let live = ""; // text of the in-progress agent_message item
      publishDraft("", true);
      for await (const event of events) {
        if (event.type === "thread.started") {
          if (event.thread_id && event.thread_id !== threadId) {
            threadId = event.thread_id;
            patchEntry(key, { threadId });
          }
          triggerTranscriptCatchUp();
        } else if (
          (event.type === "item.updated" || event.type === "item.completed") &&
          event.item.type === "agent_message"
        ) {
          if (event.type === "item.completed") {
            completed += (completed ? "\n\n" : "") + event.item.text;
            live = "";
          } else {
            live = event.item.text;
          }
          const draft = completed + (completed && live ? "\n\n" : "") + live;
          if (draft) publishDraft(draft);
          triggerTranscriptCatchUp();
        } else if (event.type === "item.completed") {
          // Tool/file/search items landing in the rollout — index them live.
          triggerTranscriptCatchUp();
        } else if (event.type === "turn.failed") {
          throw new Error(String(event.error?.message ?? "turn failed").slice(0, 800));
        } else if (event.type === "error") {
          throw new Error(String(event.message ?? "thread error").slice(0, 800));
        }
      }
    } catch (e) {
      if (signal.aborted) return; // interrupted on purpose — not an error
      console.error(
        `codex-aisdk-session turn failed: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      triggerTranscriptCatchUp();
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
