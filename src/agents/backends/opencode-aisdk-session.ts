// Headless interactive session harness for the "opencode" agent kind.
//
// This is the long-lived process behind a managed opencode session. Like its
// Claude/codex siblings (./aisdk-session.ts, ./codex-aisdk-session.ts) it runs
// inside a tmux pane used purely as a process supervisor + lifecycle handle (we
// never drive I/O through the pane), and drives a multi-turn conversation
// through the OFFICIAL @opencode-ai/sdk: `createOpencodeServer()` boots a local
// `opencode serve`, and the generated client drives it over HTTP. Auth is
// opencode's own config (~/.config/opencode auth); there is NO API key.
//
// History: this harness previously went through the Vercel AI SDK
// (ai-sdk-provider-opencode-sdk). The official SDK removes the adapter's worst
// contortions: the session id is known at session.create() BEFORE turn 1 (the
// provider only revealed it in post-turn providerMetadata), interrupt is a real
// session.abort() call, and the reply arrives as structured parts instead of
// text deltas interleaved with "unmapped event" error parts.
//
// Control plane is identical to the other harnesses:
//   - control IN: we tail a command file (data/aisdk/<key>.cmd) for
//     send / set_model / interrupt / close, written by the serve endpoints.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//
// THE KEY DIFFERENCE from both siblings is the transcript. Claude lets the SDK
// write the standard JSONL for us; codex persists a rollout we can discover.
// opencode does NEITHER — it keeps conversation state server-side — so this
// harness SELF-PERSISTS a transcript in the EXACT Claude-projects JSONL shape,
// at the exact path findTranscriptById() resolves, so lfg's existing Claude
// discovery + live stream read it unchanged.
//
// Id model: we mint a deterministic transcript UUID up front and use it as BOTH
// the control-plane KEY (registry/command file names) AND the transcript file
// name. opencode's own session id (its resume handle) is created up front too
// and stored in the registry's threadId slot.
import {
  type AisdkCommand,
  cmdPath,
  patchEntry,
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

// The SDK's server bootstrap spawns a bare `opencode` (inheriting PATH), with
// no binary-path option — so resolve the binary ourselves and prepend its
// directory to PATH first. Resolution order: LFG_OPENCODE_PATH override, then a
// PATH lookup, then this repo's node_modules/.bin/opencode (the `opencode-ai`
// dep installs it there).
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

function ensureOpencodeOnPath(): void {
  const bin = resolveOpencodePath();
  if (!bin) return;
  const dir = bin.slice(0, Math.max(bin.lastIndexOf("/"), 0)) || ".";
  const cur = process.env.PATH ?? "";
  if (!cur.split(":").includes(dir)) process.env.PATH = dir + ":" + cur;
}

// "anthropic/claude-sonnet-4-6" → { providerID, modelID }. No slash → let the
// server pick its configured default model.
function modelRef(model: string): { providerID: string; modelID: string } | undefined {
  const i = model.indexOf("/");
  if (i <= 0) return undefined;
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

type OcPart = { type?: string; text?: string; tool?: string; state?: { input?: unknown } };

function partsToBlocks(parts: OcPart[]): { text: string; blocks: unknown[] } {
  let text = "";
  const blocks: unknown[] = [];
  for (const p of parts) {
    if (p?.type === "text" && typeof p.text === "string") {
      text += (text ? "\n\n" : "") + p.text;
    } else if (p?.type === "tool") {
      blocks.push({ type: "tool_use", name: p.tool ?? "tool", input: p.state?.input ?? {} });
    }
  }
  return { text, blocks };
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

// One-shot headless run for the auto/report runner: own server, one session,
// one blocking prompt.
export async function pipeToOpencodeAiSdk(
  prompt: string,
  log: (s: string) => void,
  opts: { model?: string; cwd?: string } = {},
): Promise<string> {
  const model = opts.model ?? "opencode/big-pickle";
  const cwd = opts.cwd ?? process.cwd();
  ensureOpencodeOnPath();
  const { createOpencodeServer, createOpencodeClient } = await import("@opencode-ai/sdk");

  log(`[runner] piping ${prompt.length} chars to opencode via opencode-sdk (${model})`);
  const server = await createOpencodeServer({});
  try {
    const client = createOpencodeClient({ baseUrl: server.url });
    const created = await client.session.create({ body: {}, query: { directory: cwd } });
    if (created.error || !created.data?.id)
      throw new Error(`opencode session.create failed: ${JSON.stringify(created.error).slice(0, 300)}`);
    const res = await client.session.prompt({
      path: { id: created.data.id },
      query: { directory: cwd },
      body: {
        ...(modelRef(model) ? { model: modelRef(model) } : {}),
        parts: [{ type: "text", text: prompt }],
      },
    });
    if (res.error)
      throw new Error(`opencode prompt failed: ${JSON.stringify(res.error).slice(0, 500)}`);
    const { text } = partsToBlocks((res.data?.parts ?? []) as OcPart[]);
    if (!text.trim()) throw new Error("opencode sdk backend produced empty result");
    log(`[runner] opencode sdk done (${text.length} chars)`);
    return text.trim();
  } finally {
    server.close();
  }
}

// ---- Self-persisted Claude-shaped transcript ----------------------------------
// We replicate exactly what lfg's Claude discovery reads (see the previous
// revision's notes): path ~/.claude/projects/<enc-cwd>/<uuid>.jsonl, minimal
// user/assistant line envelopes with the fields normalizeLineMessages parses.
function transcriptPathFor(cwd: string, uuid: string): string {
  const enc = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", enc, `${uuid}.jsonl`);
}

export async function cmdOpencodeAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files AND the
  // transcript file (we own it, so they're one id).
  const keyArg = arg(argv, "--key");
  let model = arg(argv, "--model") ?? "anthropic/claude-sonnet-4-6";
  const cwd = arg(argv, "--cwd") ?? process.cwd();
  const tmuxName = arg(argv, "--tmux") ?? "";
  // Resuming: opencode session ids persist server-side, so a relaunched harness
  // can be handed one (registry threadId) and continue the conversation.
  const resumeOcId = arg(argv, "--resume");
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
  const { createOpencodeServer, createOpencodeClient } = await import("@opencode-ai/sdk");

  // One server + client per harness, reused across every turn.
  const server = await createOpencodeServer({});
  const client = createOpencodeClient({ baseUrl: server.url });

  // The transcript we OWN — minted up front so the live view can read it before
  // the first turn completes.
  const transcriptPath = transcriptPathFor(cwd, key);
  try {
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
  } catch {}
  let runningOffset = 0;
  try {
    runningOffset = statSync(transcriptPath).size;
  } catch {}
  let parentUuid: string | null = null;

  function appendLine(obj: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(obj);
      const offset = runningOffset;
      appendFileSync(transcriptPath, line + "\n");
      runningOffset += Buffer.byteLength(line) + 1;
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
  function writeAssistant(content: unknown[], apiError = false): void {
    if (!content.length) return;
    const uuid = crypto.randomUUID();
    appendLine({
      parentUuid,
      type: "assistant",
      ...(apiError ? { isApiErrorMessage: true } : {}),
      message: { role: "assistant", model, content },
      uuid,
      timestamp: new Date().toISOString(),
      cwd,
      sessionId: key,
    });
    parentUuid = uuid;
  }

  // opencode session — created UP FRONT (the old provider only revealed the id
  // after turn 1), or adopted from --resume for a relaunched harness.
  let ocSessionId: string | null = resumeOcId ?? null;
  if (!ocSessionId) {
    const created = await client.session.create({
      body: { ...(initialPrompt ? { title: initialPrompt.slice(0, 72) } : {}) },
      query: { directory: cwd },
    });
    if (created.error || !created.data?.id) {
      console.error(
        `opencode-aisdk-session: session.create failed: ${JSON.stringify(created.error).slice(0, 400)}`,
      );
      server.close();
      process.exit(1);
    }
    ocSessionId = created.data.id;
  }

  // Control-plane registry entry — threadId (opencode's resume id) is known
  // immediately now, so the live view never has to fall back.
  writeEntry({
    sessionId: key,
    agent: "opencode",
    threadId: ocSessionId,
    harnessPid: process.pid,
    tmuxName,
    cwd,
    model,
    busy: false,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  const queue: string[] = [];
  let draining = false;
  let closing = false;
  let turnActive = false;
  const publishDraft = makeDraftPublisher(key);

  // Live draft: tail the server's SSE event bus and mirror in-progress text
  // parts for OUR session into the registry draft. Purely cosmetic — the turn
  // result comes from session.prompt() below — so any parse miss is harmless.
  void (async () => {
    try {
      const sub = await client.event.subscribe();
      const stream = (sub as { stream?: AsyncIterable<unknown>; data?: AsyncIterable<unknown> }).stream ??
        (sub as { data?: AsyncIterable<unknown> }).data;
      if (!stream) return;
      let draft = "";
      for await (const raw of stream) {
        if (closing) break;
        if (!turnActive) continue;
        const ev = raw as { type?: string; properties?: { part?: OcPart & { sessionID?: string } } };
        const part = ev?.properties?.part;
        if (ev?.type === "message.part.updated" && part?.sessionID === ocSessionId) {
          if (part.type === "text" && typeof part.text === "string") {
            draft = part.text;
            publishDraft(draft);
          }
        }
        if (ev?.type === "session.idle") draft = "";
      }
    } catch {
      // Event stream is best-effort; drafts just won't animate if it drops.
    }
  })();

  async function runTurn(prompt: string): Promise<void> {
    writeUser(prompt);
    turnActive = true;
    publishDraft("", true);
    try {
      const res = await client.session.prompt({
        path: { id: ocSessionId! },
        query: { directory: cwd },
        body: {
          ...(modelRef(model) ? { model: modelRef(model) } : {}),
          parts: [{ type: "text", text: prompt }],
        },
      });
      if (res.error) {
        const msg = JSON.stringify(res.error).slice(0, 500);
        console.error(`opencode-aisdk-session turn failed: ${msg}`);
        writeAssistant([{ type: "text", text: `OpenCode turn failed for ${model}: ${msg}` }], true);
        return;
      }
      const { text, blocks } = partsToBlocks((res.data?.parts ?? []) as OcPart[]);
      const content: unknown[] = [];
      if (text.trim()) content.push({ type: "text", text });
      content.push(...blocks);
      if (!content.length) {
        const logged = latestOpencodeError(ocSessionId!);
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
      writeAssistant(content);
    } catch (e) {
      // session.abort() surfaces here as a failed/aborted request — if we're
      // mid-interrupt that's expected; otherwise record the failure.
      const msg = e instanceof Error ? e.message : String(e);
      if (!closing) {
        console.error(`opencode-aisdk-session turn failed: ${msg}`);
        writeAssistant([{ type: "text", text: `OpenCode turn failed for ${model}: ${msg}` }], true);
      }
    } finally {
      turnActive = false;
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
    if (!turnActive || !ocSessionId) return;
    void client.session
      .abort({ path: { id: ocSessionId }, query: { directory: cwd } })
      .catch(() => {});
  }

  function shutdown(): void {
    closing = true;
    interrupt();
    removeEntry(key);
    try {
      server.close();
    } catch {}
    setTimeout(() => process.exit(0), 50);
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
      interrupt();
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
