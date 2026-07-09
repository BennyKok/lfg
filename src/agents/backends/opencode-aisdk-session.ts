// Headless interactive session harness for the "opencode" agent kind.
//
// This is the long-lived process behind an "opencode (ai sdk)" session. Like its
// Claude/codex siblings (./aisdk-session.ts, ./codex-aisdk-session.ts) it runs
// inside a tmux pane used purely as a process supervisor + lifecycle handle (we
// never drive I/O through the pane), and drives a multi-turn conversation through
// the Vercel AI SDK — here via the ai-sdk-provider-opencode-sdk provider, which
// talks to a local `opencode serve` HTTP server (auto-started). Auth is
// opencode's own config (~/.config/opencode auth); there is NO API key.
//
// Control plane is identical to the other AI-SDK harnesses:
//   - control IN: we tail a command file (data/aisdk/<key>.cmd) for
//     send / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//
// THE KEY DIFFERENCE from both siblings is the transcript. Claude lets the SDK
// write the standard JSONL for us; codex persists a rollout we can discover.
// opencode does NEITHER — it keeps conversation state server-side and writes no
// transcript file our discovery can read. So this harness SELF-PERSISTS a
// transcript in the EXACT Claude-projects JSONL shape, at the exact path
// findTranscriptById() resolves, so lfg's existing Claude discovery + SSE live
// stream read it unchanged with zero opencode-specific code on the read side.
//
// Id model: we mint a deterministic transcript UUID up front and use it as BOTH
// the control-plane KEY (registry/command file names) AND the transcript file
// name — we own the file, so they can be the same id (unlike codex, where the
// transcript id is assigned by the app-server after turn 1). opencode's own
// resume sessionId is learned after turn 1 and stored in the registry's threadId
// slot, used to resume the conversation on later turns. It is NOT surfaced as the
// live-view id (that stays the transcript uuid we wrote).
//
// Interrupt is an AbortController on the current turn — staying purely on the AI
// SDK surface (the provider aborts the in-flight request for us).
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
  readEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import { normalizeLineMessages } from "../../sessions.ts";
import { indexTranscriptMessages } from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// The provider's HTTP server is started by @opencode-ai/sdk via a bare
// `opencode serve` (cross-spawn, inheriting PATH) — there is no option in the
// installed types to pass a binary path. So we resolve the opencode binary
// ourselves and prepend its directory to PATH before the provider spawns it.
// Resolution order: LFG_OPENCODE_PATH override, then a PATH lookup, then this
// repo's node_modules/.bin/opencode (the `opencode-ai` dep installs it there).
function resolveOpencodePath(): string | undefined {
  try {
    if (process.env.LFG_OPENCODE_PATH) return process.env.LFG_OPENCODE_PATH;
    const onPath = Bun.which("opencode");
    if (onPath) return onPath;
    // import.meta.dir is …/src/agents/backends — climb to the repo root.
    const local = join(import.meta.dir, "../../../node_modules/.bin/opencode");
    return local;
  } catch {
    return undefined;
  }
}

// Make a resolved opencode binary discoverable to the SDK's bare `opencode`
// spawn by prepending its directory to PATH. No-op if we couldn't resolve one
// (then we rely on whatever PATH the harness inherited).
function ensureOpencodeOnPath(): void {
  const bin = resolveOpencodePath();
  if (!bin) return;
  const dir = bin.slice(0, Math.max(bin.lastIndexOf("/"), 0)) || ".";
  const sep = ":";
  const cur = process.env.PATH ?? "";
  if (!cur.split(sep).includes(dir)) process.env.PATH = dir + sep + cur;
}

export async function pipeToOpencodeAiSdk(
  prompt: string,
  log: (s: string) => void,
  opts: { model?: string; cwd?: string } = {},
): Promise<string> {
  const model = opts.model ?? "opencode/big-pickle";
  const cwd = opts.cwd ?? process.cwd();
  ensureOpencodeOnPath();
  const { streamText } = await import("ai");
  const { createOpencode } = await import("ai-sdk-provider-opencode-sdk");

  log(`[runner] piping ${prompt.length} chars to opencode via ai-sdk (${model})`);
  const provider = createOpencode({
    autoStartServer: true,
    defaultSettings: { directory: cwd },
  });

  try {
    const result = streamText({ model: provider(model), prompt });
    let textBuf = "";
    let lastEmit = 0;
    const flush = (force = false) => {
      const now = Date.now();
      if (force || now - lastEmit > 800) {
        lastEmit = now;
        const k = textBuf.length >= 1000 ? `${(textBuf.length / 1000).toFixed(1)}k` : String(textBuf.length);
        log(`[runner] opencode generating… ${k} chars`);
      }
    };
    for await (const part of result.fullStream as any) {
      if (part?.type === "text-delta") {
        textBuf += String(part.text ?? part.textDelta ?? part.delta ?? "");
        flush();
      } else if (part?.type === "tool-call") {
        log(`[runner] opencode running tool: ${part.toolName ?? "?"}`);
      } else if (part?.type === "error") {
        throw new Error(String((part as any).error).slice(0, 800));
      }
    }
    const text = await result.text;
    flush(true);
    const out = (text || textBuf).trim();
    if (!out) throw new Error("opencode ai-sdk backend produced empty result");
    log(`[runner] opencode ai-sdk done (${out.length} chars)`);
    return out;
  } finally {
    await provider.dispose?.().catch(() => {});
  }
}

// ---- Self-persisted Claude-shaped transcript ----------------------------------
// We replicate exactly what lfg's Claude discovery reads:
//   path: ~/.claude/projects/<enc-cwd>/<uuid>.jsonl, enc-cwd = cwd with every
//         "/" replaced by "-" (the same encoding candidateDirs() expects; and
//         findTranscriptById scans every dir anyway, so the file is found).
//   line envelope (copied from a real file under ~/.claude/projects/*/*.jsonl):
//     user:      { parentUuid, type:"user", message:{ role:"user",
//                  content:[{type:"text",text}] }, uuid, timestamp, cwd,
//                  sessionId }
//     assistant: { parentUuid, type:"assistant", message:{ role:"assistant",
//                  model, content:[{type:"text",text}|{type:"tool_use",name,
//                  input}] }, uuid, timestamp, cwd, sessionId }
// These are exactly the fields normalizeLineMessages / lastUserText /
// firstPromptTitle / lastAssistantModel parse — everything else Claude writes is
// ignored by the reader, so we keep our envelope minimal but faithful.
function transcriptPathFor(cwd: string, uuid: string): string {
  const enc = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", enc, `${uuid}.jsonl`);
}

function latestOpencodeError(opencodeSessionId: string): string | null {
  try {
    const log = readFileSync(
      join(homedir(), ".local", "share", "opencode", "log", "opencode.log"),
      "utf8",
    );
    const lines = log.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes(`session.id=${opencodeSessionId}`) || !line.includes("level=ERROR"))
        continue;
      const quoted = line.match(/\berror(?:\.error)?="([^"]+)"/)?.[1];
      if (quoted) return quoted.replace(/\\"/g, '"');
      const bare = line.match(/\berror=([^ ]+)/)?.[1];
      if (bare) return bare;
      return "OpenCode reported an error for this turn";
    }
  } catch {}
  return null;
}

export async function cmdOpencodeAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files AND the
  // transcript file (we own it, so they're one id).
  const keyArg = arg(argv, "--key");
  let model = arg(argv, "--model") ?? "anthropic/claude-sonnet-4-6";
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  // Everything after `--` is the initial prompt (mirrors the other harnesses).
  const dashI = argv.indexOf("--");
  const initialPrompt = dashI >= 0 ? argv.slice(dashI + 1).join(" ").trim() : "";

  if (!keyArg) {
    console.error("opencode-aisdk-session: --key <uuid> is required");
    process.exit(1);
  }
  const key: string = keyArg;

  try {
    process.chdir(cwd);
  } catch {}

  ensureOpencodeOnPath();

  const { streamText } = await import("ai");
  // Lazy-import the provider so the rest of the CLI never hard-depends on it.
  const { createOpencode } = await import("ai-sdk-provider-opencode-sdk");

  // One provider per harness; it owns the auto-started `opencode serve` child,
  // reused across every turn (and resume). directory scopes opencode's file
  // operations to this session's cwd. (The settings expose `cwd` too but it's
  // deprecated in favor of `directory`.)
  const provider = createOpencode({
    autoStartServer: true,
    defaultSettings: { directory: cwd },
  });

  // The transcript we OWN — minted up front so the file path is known before the
  // first turn and the live view can deep-link to it immediately.
  const transcriptPath = transcriptPathFor(cwd, key);
  try {
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
  } catch {}
  let runningOffset = 0;
  try {
    runningOffset = statSync(transcriptPath).size;
  } catch {}
  let parentUuid: string | null = null; // chain lines like Claude does

  // Append one transcript line, tolerating any malformed input (a single bad
  // turn must never crash the harness or corrupt the file).
  function appendLine(obj: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(obj);
      const offset = runningOffset;
      appendFileSync(transcriptPath, line + "\n");
      runningOffset += Buffer.byteLength(line) + 1;
      // Pin the cursor mtime to the file's ACTUAL mtime (not Date.now()) so the
      // read-path currency check (cursor.mtimeMs === st.mtimeMs) matches and no
      // redundant background catch-up is enqueued back onto serve's loop.
      let mtimeMs = Date.now();
      try {
        mtimeMs = statSync(transcriptPath).mtimeMs;
      } catch {}
      try {
        indexTranscriptMessages(transcriptPath, key, [{ offset, messages: normalizeLineMessages(line) }], {
          size: runningOffset,
          offset: runningOffset,
          mtimeMs,
        });
      } catch {}
    } catch {}
  }
  function writeUser(text: string): void {
    const uuid = crypto.randomUUID();
    appendLine({
      parentUuid,
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId: key,
    });
    parentUuid = uuid;
  }
  // content is the assembled block list (text + any tool_use blocks).
  function writeAssistant(content: unknown[], apiError = false): void {
    if (!content.length) return; // nothing to record (e.g. an empty/aborted turn)
    const uuid = crypto.randomUUID();
    appendLine({
      parentUuid,
      type: "assistant",
      ...(apiError ? { isApiErrorMessage: true } : {}),
      // model lets lastAssistantModel() show the live model on the card.
      message: { role: "assistant", model, content },
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId: key,
    });
    parentUuid = uuid;
  }

  // Control-plane registry entry — the moment this exists (and our pid is alive),
  // serve surfaces the session in the live view. threadId (opencode's resume id)
  // starts null and is patched in after turn 1.
  writeEntry({
    sessionId: key,
    agent: "opencode",
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
  let sessionId: string | null = null; // opencode resume id, learned after turn 1
  let currentAc: AbortController | null = null;
  let draining = false;
  let closing = false;
  // Publish in-flight assistant text to the registry entry (keyed by the
  // control-plane uuid) so the web live view animates the reply as it streams
  // without persisting partial snapshots into the transcript.
  const publishDraft = makeDraftPublisher(key);

  async function runTurn(prompt: string, signal: AbortSignal): Promise<void> {
    // Record the user turn immediately so it surfaces in the live view even
    // before the assistant replies.
    writeUser(prompt);

    // If we don't have an opencode resume id in memory yet (e.g. previous turn
    // ended on a question before we captured metadata), try to hydrate from the
    // on-disk registry entry (which may have been patched manually or by serve).
    if (!sessionId) {
      try {
        const onDisk = readEntry(key);
        if (onDisk?.threadId && typeof onDisk.threadId === "string") {
          sessionId = onDisk.threadId;
        }
      } catch {}
    }

    // First turn: no sessionId → the provider creates a fresh opencode session.
    // Later turns: pass the captured sessionId to resume the same conversation.
    // (sessionId lives in the MODEL settings, the 2nd arg — NOT providerOptions,
    // which is where the codex provider wanted its threadId.)
    const llm = sessionId ? provider(model, { sessionId }) : provider(model);

    const result = streamText({
      model: llm,
      prompt,
      abortSignal: signal,
    });

    // Accumulate assistant output into Claude-shaped content blocks. Text is the
    // priority; tool calls are recorded best-effort as tool_use blocks. Never
    // throw out of the part loop on a malformed/unknown part.
    let textBuf = "";
    const toolBlocks: unknown[] = [];

    try {
      publishDraft("", true); // reset the animated draft at turn start
      for await (const part of result.fullStream as any) {
        try {
          const t = part?.type;
          if (t === "error") {
            const errText = String((part as any).error);
            // The opencode provider emits an "error" stream part for events it
            // hasn't mapped yet — notably `question.asked` (the interactive
            // question event, which this headless harness can't answer anyway).
            if (/question\.asked|not yet mapped|question asked|asking/i.test(errText)) {
              console.error(
                `opencode-aisdk-session: ignoring unmapped stream event — ${errText.slice(0, 200)}`,
              );
              // Do not continue awaiting; finish the turn so we don't hang with busy=true.
              // Any preceding text/tool output will be flushed below.
              throw new Error("OPENCODE_QUESTION_ASKED");
            } else {
              throw new Error(errText.slice(0, 800));
            }
          } else if (t === "text-delta") {
            // AI SDK streams text as `text-delta` parts; tolerate both current
            // and older provider field names.
            textBuf +=
              (part as any).text ?? (part as any).textDelta ?? (part as any).delta ?? "";
            publishDraft(textBuf);
          } else if (t === "tool-call") {
            // Flush whatever text preceded this tool so the live view shows the
            // progress instead of jumping straight to the next phase.
            publishDraft(textBuf, true);
            const toolName = (part as any).toolName ?? (part as any).tool ?? "tool";
            const input = (part as any).input ?? (part as any).args ?? {};
            if (/^question$/i.test(String(toolName)) || (input && (input.questions || input.question))) {
              toolBlocks.push({ type: "tool_use", name: "question", input });
              // This is an interactive prompt from opencode (multiple choice etc).
              // The stream will not advance until answered. Finish the turn now
              // so the harness does not hang with busy=true forever.
              throw new Error("OPENCODE_QUESTION_ASKED");
            }
            toolBlocks.push({ type: "tool_use", name: toolName, input });
          }
        } catch (inner) {
          // A single bad part shouldn't abort the whole turn — but a thrown
          // `error` part is a real failure, so rethrow it to the outer catch.
          if (inner instanceof Error && inner.message) throw inner;
        }
      }

      // Opportunistic detection: opencode "asking" (with options) sometimes ends the
      // stream without yielding an explicit "tool-call" for question or a matching
      // error part (especially after tool uses in build mode). If the log shows a
      // recent ask, treat it like the other cases so we don't hang.
      try {
        const logPath = join(homedir(), ".local", "share", "opencode", "log", "opencode.log");
        const log = readFileSync(logPath, "utf8");
        const recent = log.split("\n").slice(-50).join("\n");
        if (/message=asking|questions=\d+/i.test(recent)) {
          throw new Error("OPENCODE_QUESTION_ASKED");
        }
      } catch (e) {
        if ((e as any)?.message === "OPENCODE_QUESTION_ASKED") throw e;
      }

      publishDraft(textBuf, true);
      await result.text; // surfaces a failed generation

      // Capture opencode's resume sessionId from the resolved metadata and pin
      // it for resume on later turns. It is NOT a transcript id (we own the
      // transcript), so it only ever feeds provider(model, { sessionId }).
      let turnOpencodeSessionId: string | null = null;
      try {
        const meta = (await result.providerMetadata) as any;
        const id = meta?.opencode?.sessionId;
        if (typeof id === "string" && id) {
          turnOpencodeSessionId = id;
          if (!sessionId) {
            sessionId = id;
            patchEntry(key, { threadId: sessionId });
          }
        }
      } catch {}

      if (!textBuf.trim() && !toolBlocks.length) {
        let logged: string | null = null;
        if (turnOpencodeSessionId) {
          for (let i = 0; i < 5 && !logged; i++) {
            if (i) await new Promise((res) => setTimeout(res, 100));
            logged = latestOpencodeError(turnOpencodeSessionId);
          }
        }
        writeAssistant(
          [
            {
              type: "text",
              text: logged
                ? `OpenCode turn failed for ${model}: ${logged}`
                : `OpenCode returned no assistant output for ${model}; check the OpenCode provider logs.`,
            },
          ],
          true,
        );
        return;
      }
    } catch (e) {
      if (signal.aborted) {
        // Interrupted on purpose — still persist whatever streamed so far.
        // Best-effort: capture opencode sessionId for resume if available.
        try {
          const meta = (await result?.providerMetadata) as any;
          const id = meta?.opencode?.sessionId;
          if (typeof id === "string" && id && !sessionId) {
            sessionId = id;
            patchEntry(key, { threadId: sessionId });
          }
        } catch {}
        flushAssistant(textBuf, toolBlocks);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      if (message === "OPENCODE_QUESTION_ASKED") {
        // opencode injected an interactive question tool (e.g. "how should I proceed?").
        // Headless harness cannot answer; record what we have + a clear note and end turn.
        // Capture sessionId if present so follow-ups can resume the same opencode thread.
        try {
          const meta = (await result?.providerMetadata) as any;
          const id = meta?.opencode?.sessionId;
          if (typeof id === "string" && id && !sessionId) {
            sessionId = id;
            patchEntry(key, { threadId: sessionId });
          }
        } catch {}
        flushAssistant(textBuf, toolBlocks);
        writeAssistant(
          [
            {
              type: "text",
              text: "OpenCode asked an interactive question during this turn (see transcript or opencode logs for the options). This headless session cannot answer; reply with your choice or restart the session to continue.",
            },
          ],
          true,
        );
        return;
      }
      console.error(`opencode-aisdk-session turn failed: ${message}`);
      flushAssistant(textBuf, toolBlocks);
      writeAssistant(
        [{ type: "text", text: `OpenCode turn failed for ${model}: ${message}` }],
        true,
      );
      return;
    }
    flushAssistant(textBuf, toolBlocks);
  }

  // Write the assistant turn: a text block (if any) followed by tool_use blocks.
  function flushAssistant(text: string, toolBlocks: unknown[]): void {
    const content: unknown[] = [];
    if (text.trim()) content.push({ type: "text", text });
    for (const b of toolBlocks) content.push(b);
    writeAssistant(content);
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
    // Dispose the provider so the auto-started `opencode serve` child doesn't
    // linger. (The installed types expose `dispose()`, not `close()`.)
    void Promise.resolve()
      .then(() => provider.dispose?.())
      .catch(() => {})
      // Give the registry write + provider dispose a tick, then exit so the
      // tmux pane closes.
      .finally(() => setTimeout(() => process.exit(0), 50));
  }

  function dispatch(cmd: AisdkCommand): void {
    if (cmd.type === "send") {
      if (cmd.text.trim()) {
        queue.push(cmd.text);
        void drain();
      }
    } else if (cmd.type === "set_model") {
      const next = cmd.model.trim();
      if (next) {
        model = next;
        patchEntry(key, { model });
      }
    } else if (cmd.type === "interrupt") {
      currentAc?.abort();
    } else if (cmd.type === "close") {
      shutdown();
    }
  }

  // Tail the command file by byte offset — same polling approach as the other
  // harnesses (simple + reliable across filesystems; 250ms is interactive).
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

// Run directly: `bun src/agents/backends/opencode-aisdk-session.ts --key <uuid> ...`.
// Spawned standalone by spawnManagedOpencodeAisdkSession (not via the lfg CLI) so
// the harness has no dependency on the rest of the command surface.
if (import.meta.main) {
  cmdOpencodeAisdkSession(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
