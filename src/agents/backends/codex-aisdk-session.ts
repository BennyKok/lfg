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
import { readFileSync } from "node:fs";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function resolveCodexPath(): string | undefined {
  try {
    return process.env.LFG_CODEX_PATH ?? Bun.which("codex") ?? undefined;
  } catch {
    return undefined;
  }
}

export async function cmdCodexAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files. NOT the
  // codex thread id (which we don't know until after turn 1).
  const keyArg = arg(argv, "--key");
  const model = arg(argv, "--model") ?? "gpt-5.5";
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
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
  let threadId: string | null = null; // learned early via onSessionCreated, then reused to resume

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
    threadId: null,
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
    const llm = provider(model);

    const result = streamText({
      model: llm,
      prompt,
      abortSignal: signal,
      providerOptions: { "codex-app-server": codexOpts },
    } as any);
    try {
      for await (const part of result.fullStream as any) {
        if (part?.type === "error") {
          throw new Error(String((part as any).error).slice(0, 800));
        }
      }
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
          }
        } catch {}
      }
    } catch (e) {
      if (signal.aborted) return; // interrupted on purpose — not an error
      console.error(
        `codex-aisdk-session turn failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closing) {
        const prompt = queue.shift()!;
        currentAc = new AbortController();
        patchEntry(key, { busy: true });
        try {
          await runTurn(prompt, currentAc.signal);
        } finally {
          currentAc = null;
          patchEntry(key, { busy: false });
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
