// Headless interactive session harness for the "codex-aisdk" agent kind.
//
// This is the long-lived process behind a "codex (ai sdk)" session. Like its
// Claude sibling (./aisdk-session.ts) it runs inside a tmux pane used purely as
// a process supervisor + lifecycle handle (we never drive I/O through the pane),
// and drives a multi-turn conversation through the Vercel AI SDK — here via the
// ai-sdk-provider-codex-cli app-server provider, which talks JSON-RPC to a
// `codex app-server` child over stdio. ChatGPT-subscription auth comes from
// ~/.codex/auth.json; there is NO API key.
//
// Control plane is identical to the Claude harness:
//   - control IN: we tail a command file (data/aisdk/<key>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//
// The KEY DIFFERENCE from the Claude harness is the id model. Claude lets us
// choose a deterministic sessionId up front and writes the transcript JSONL
// there. Codex does NOT: the `app-server` mints a `threadId` we only learn AFTER
// turn 1 (from result.providerMetadata['codex-app-server'].threadId), and it
// persists the rollout under ~/.codex/sessions/... named by that id. So:
//   - We mint a control-plane KEY (a uuid) up front, used ONLY to name the
//     registry/command files. serve routes sends/interrupts through it.
//   - Turn 1 runs with providerOptions { threadMode: 'persistent' }; afterwards
//     we read the threadId and patch it into the registry.
//   - Later turns resume with providerOptions { threadId }.
// The transcript itself is discovered by the EXISTING findCodexTranscriptById /
// codexThreads once the threadId is known — we never write a custom transcript.
//
// Interrupt is an AbortController on the current turn — staying purely on the AI
// SDK surface (the provider aborts the in-flight RPC turn for us).
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

function resolveCodexPath(): string | undefined {
  const usable = (path: string | undefined | null): string | undefined => {
    if (!path) return undefined;
    try {
      const real = realpathSync(path);
      return existsSync(real) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const explicit = usable(process.env.LFG_CODEX_PATH);
    if (explicit) return explicit;
    // The provider defaults to its optional local @openai/codex dependency when
    // codexPath is absent. Prefer the user's global CLI so resumed app-server
    // sessions do not get pinned to an older repo-local wrapper.
    const global = usable(`${homedir()}/.bun/bin/codex`);
    if (global) return global;
    return usable(Bun.which("codex")) ?? undefined;
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

export async function pipeToCodexAiSdk(
  prompt: string,
  log: (s: string) => void,
  opts: { model?: string; thinkingLevel?: string; cwd?: string } = {},
): Promise<string> {
  const model = opts.model ?? "gpt-5.5";
  const cwd = opts.cwd ?? process.cwd();
  const thinkingLevel = opts.thinkingLevel;
  const codexPath = resolveCodexPath();
  const { streamText } = await import("ai");
  const { createCodexAppServer } = await import("ai-sdk-provider-codex-cli");

  log(`[runner] piping ${prompt.length} chars to codex via ai-sdk (${model})`);
  const provider = createCodexAppServer({
    defaultSettings: {
      cwd,
      sandboxPolicy: "danger-full-access",
      approvalPolicy: "never",
      autoApprove: true,
      ...(codexPath ? { codexPath } : {}),
    },
  });

  try {
    const llm = provider(
      model,
      thinkingLevel ? { effort: thinkingLevel as any } : undefined,
    );
    const result = streamText({
      model: llm,
      prompt,
      providerOptions: {
        "codex-app-server": {
          threadMode: "stateless",
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
        },
      },
    } as any);
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
    for await (const part of result.fullStream as any) {
      if (part?.type === "text-delta") {
        chars += String(part.text ?? part.textDelta ?? part.delta ?? "").length;
        flush();
      } else if (part?.type === "tool-call") {
        log(`[runner] codex running tool: ${part.toolName ?? "?"}`);
      } else if (part?.type === "error") {
        throw new Error(String((part as any).error).slice(0, 800));
      }
    }
    const text = await result.text;
    flush(true);
    if (!text || !text.trim()) throw new Error("codex ai-sdk backend produced empty result");
    log(`[runner] codex ai-sdk done (${text.length} chars)`);
    return text;
  } finally {
    await provider.dispose?.().catch(() => {});
  }
}

export async function cmdCodexAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files. NOT the
  // codex thread id (which we don't know until after turn 1).
  const keyArg = arg(argv, "--key");
  const model = arg(argv, "--model") ?? "gpt-5.5";
  const thinkingLevel = arg(argv, "--thinking-level");
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  // Resuming a closed codex session: the rollout's threadId is known up front, so
  // we seed `threadId` with it (below) and turn 1 resumes that thread instead of
  // minting a new persistent one. Absent on a fresh session.
  const resumeThreadId = arg(argv, "--resume");
  // Everything after `--` is the initial prompt (mirrors how the Claude harness
  // and the tmux codex session pass the first message).
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

  const codexPath = resolveCodexPath();
  const { streamText } = await import("ai");
  // Lazy-import the provider so the rest of the CLI never hard-depends on it.
  const { createCodexAppServer } = await import("ai-sdk-provider-codex-cli");
  // When resuming, the threadId is the rollout id we were handed; seed it so the
  // first turn resumes that thread. Otherwise it's learned early via
  // onSessionCreated, then reused to resume on later turns.
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
      // threadId is discovery-only. Using threadId here would churn the
      // session_id column against the monitor and break search-by-session.
      await ensureChatTranscriptCaughtUp(path, key, "codex-aisdk-stream");
    })().catch(() => {});
  }

  // One provider per harness: it owns a shared `codex app-server` child process
  // reused across every turn (and resumed thread). Full-access + never-approve
  // mirrors the tmux codex session's `--sandbox danger-full-access
  // --ask-for-approval never`. (NB: the app-server settings name these
  // `sandboxPolicy`/`approvalPolicy`, not the exec-mode `sandboxMode`/
  // `approvalMode` — see the installed types.)
  const provider = createCodexAppServer({
    defaultSettings: {
      cwd,
      sandboxPolicy: "danger-full-access",
      approvalPolicy: "never",
      // Auto-answer any approval request the provider can't route through a
      // handler, so an unattended turn never blocks waiting on stdin.
      autoApprove: true,
      // Codex creates the persistent app-server thread before the turn
      // completes. Publish that id immediately so lfg can tail the rollout
      // transcript while the first response is still running.
      onSessionCreated: (session: { threadId?: string }) => {
        if (typeof session.threadId === "string" && session.threadId) {
          threadId = session.threadId;
          patchEntry(key, { threadId });
          triggerTranscriptCatchUp();
        }
      },
      ...(codexPath ? { codexPath } : {}),
    },
  });

  // Control-plane registry entry — the moment this exists (and our pid is alive),
  // serve surfaces the session in the live view. threadId starts null: the live
  // view falls back to the control-plane key until turn 1 reports the real id.
  writeEntry({
    sessionId: key,
    agent: "codex",
    // Resumed sessions already know their threadId, so publish it now (the live
    // view + transcript discovery key off it). Fresh sessions start null and get
    // patched once turn 1 reports the id.
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
    // No AskUserQuestion handling needed here: the codex app-server provider
    // auto-responds {answers:{}} to any interactive question, so this headless
    // turn never blocks waiting on an answer (unlike the Claude/opencode paths).
    // First turn: ask the app-server to start a PERSISTENT thread so we can
    // resume it. Every later turn: resume the known threadId. (The provider
    // rejects an unknown threadId, so we only pass it once we've captured one.)
    const codexOpts = threadId
      ? { threadId }
      : { threadMode: "persistent" as const };
    const llm = provider(
      model,
      thinkingLevel ? { effort: thinkingLevel as any } : undefined,
    );

    const result = streamText({
      model: llm,
      prompt,
      abortSignal: signal,
      providerOptions: {
        "codex-app-server": {
          ...codexOpts,
          ...(thinkingLevel ? { effort: thinkingLevel } : {}),
        },
      },
    } as any);
    try {
      let draft = "";
      publishDraft("", true);
      for await (const part of result.fullStream as any) {
        triggerTranscriptCatchUp();
        if (part?.type === "text-delta") {
          const delta = String(part.text ?? part.textDelta ?? part.delta ?? "");
          if (delta) {
            draft += delta;
            publishDraft(draft);
          }
        } else if (part?.type === "error") {
          throw new Error(String((part as any).error).slice(0, 800));
        }
      }
      publishDraft(draft, true);
      await result.text; // surfaces a failed generation
      // The threadId only appears once a persistent turn has completed; read it
      // from the resolved metadata and pin it for resume + transcript discovery.
      if (!threadId) {
        try {
          const meta = (await result.providerMetadata) as any;
          const id = meta?.["codex-app-server"]?.threadId;
          if (typeof id === "string" && id) {
            threadId = id;
            patchEntry(key, { threadId });
            triggerTranscriptCatchUp();
          }
        } catch {}
      }
      triggerTranscriptCatchUp();
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
    // Close the shared app-server child so the codex process doesn't linger.
    void Promise.resolve()
      .then(() => provider.close?.())
      .catch(() => {})
      // Give the registry write + provider close a tick, then exit so the tmux
      // pane closes.
      .finally(() => setTimeout(() => process.exit(0), 50));
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
