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
//     send / set_model / interrupt / close / answer / dismiss.
//   - busy + discovery: a registry entry (data/aisdk/<key>.json) we keep
//     updated; serve reads it for the live-view busy dot and session list.
//   - interactive questions: OpenCode's `question` tool has no TUI here, so we
//     surface pending questions on the registry `prompt` field, drop busy while
//     waiting, and reply/reject via OpenCode's HTTP question API when the user
//     answers from the web UI (or auto-reject after a timeout).
//
// THE KEY DIFFERENCE from both siblings is the transcript. opencode keeps
// conversation state server-side, so this harness builds Claude-shaped message
// envelopes and indexes their normalized rows directly into SQLite.
//
// Id model: we mint a deterministic transcript/index UUID up front and use it as
// the control-plane KEY (registry/command file names) and SQLite path key.
// opencode's own session id (its resume handle) is created up front too and
// stored in the registry's threadId slot.
import {
  type AisdkCommand,
  type AisdkPrompt,
  cmdPath,
  patchEntry,
  removeEntry,
  writeEntry,
} from "../../aisdk-registry.ts";
import { normalizeLineMessages } from "../../sessions.ts";
import { indexSessionMessagesDirect } from "../../transcript-index.ts";
import { makeDraftPublisher } from "./draft.ts";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Headless OpenCode can't show its TUI question picker. If the user never
// answers via LFG, reject after this so the turn can't hang forever.
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

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

type OcPart = {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: { input?: unknown; status?: string; output?: unknown; error?: string };
  sessionID?: string;
  messageID?: string;
};

type OcQuestionOption = { label?: string; description?: string };
type OcQuestionInfo = {
  question?: string;
  header?: string;
  options?: OcQuestionOption[];
};
type OcPendingQuestion = {
  id: string;
  sessionID?: string;
  questions: OcQuestionInfo[];
};

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

async function ocFetchJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, init);
    if (!res.ok) return null;
    if (res.status === 204) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function listPendingQuestions(baseUrl: string): Promise<OcPendingQuestion[]> {
  const data = await ocFetchJson<OcPendingQuestion[]>(baseUrl, "/question");
  return Array.isArray(data) ? data : [];
}

async function replyQuestion(
  baseUrl: string,
  requestId: string,
  answers: string[][],
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function rejectQuestion(baseUrl: string, requestId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/$/, "")}/question/${encodeURIComponent(requestId)}/reject`,
      { method: "POST" },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** @internal exported for unit tests */
export function pendingToPrompt(pending: OcPendingQuestion): AisdkPrompt | null {
  const q = pending.questions?.[0];
  const options = Array.isArray(q?.options) ? q.options : [];
  if (!q || !options.length) return null;
  return {
    question: typeof q.question === "string" ? q.question : "OpenCode needs a choice",
    header: typeof q.header === "string" ? q.header : undefined,
    options: options.map((o, i) => ({
      index: i,
      label: typeof o?.label === "string" ? o.label : String(o ?? `Option ${i + 1}`),
      selected: i === 0,
      description: typeof o?.description === "string" ? o.description : undefined,
    })),
  };
}

/** @internal exported for unit tests */
export function answersForIndex(pending: OcPendingQuestion, index: number): string[][] {
  return (pending.questions ?? []).map((q, qi) => {
    const opts = Array.isArray(q?.options) ? q.options : [];
    const pick = opts[qi === 0 ? index : 0] ?? opts[0];
    const label = typeof pick?.label === "string" ? pick.label : "";
    return label ? [label] : [];
  });
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

function toolPartMessage(part: OcPart, fallbackId: string): ReturnType<typeof normalizeLineMessages>[number] {
  const status = part.state?.status ? ` [${part.state.status}]` : "";
  const input = part.state?.input == null
    ? ""
    : (() => {
        try {
          return JSON.stringify(part.state.input, null, 2);
        } catch {
          return String(part.state.input);
        }
      })();
  const name = part.tool ?? "tool";
  return {
    id: part.id || fallbackId,
    role: "assistant",
    kind: "tool_use",
    text: input ? `${name}${status}: ${input}` : `${name}${status}`,
    ts: Date.now(),
  };
}

// Auto runner has no human — reject any OpenCode question so the turn can't hang.
async function autoRejectPendingQuestions(baseUrl: string, sessionId: string): Promise<void> {
  const pending = (await listPendingQuestions(baseUrl)).filter(
    (q) => !q.sessionID || q.sessionID === sessionId,
  );
  for (const q of pending) {
    await rejectQuestion(baseUrl, q.id);
  }
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
    const ocId = created.data.id;
    // Headless auto runs can't answer OpenCode questions — poll + reject while
    // the blocking prompt is in flight so the turn can't hang forever.
    const rejectTimer = setInterval(() => {
      void autoRejectPendingQuestions(server.url, ocId);
    }, 1000);
    let res: { error?: unknown; data?: { parts?: OcPart[] } };
    try {
      res = (await client.session.prompt({
        path: { id: ocId },
        query: { directory: cwd },
        body: {
          ...(modelRef(model) ? { model: modelRef(model) } : {}),
          parts: [{ type: "text", text: prompt }],
        },
      })) as { error?: unknown; data?: { parts?: OcPart[] } };
    } finally {
      clearInterval(rejectTimer);
      await autoRejectPendingQuestions(server.url, ocId);
    }
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

export async function cmdOpencodeAisdkSession(argv: string[]): Promise<void> {
  // The control-plane key (a uuid) — names the registry/command files and the
  // synthetic direct-index path.
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
  const serverUrl = server.url;
  const client = createOpencodeClient({ baseUrl: serverUrl });

  let parentUuid: string | null = null;

  function indexEnvelope(obj: Record<string, unknown>): void {
    try {
      const line = JSON.stringify(obj);
      const now = Date.now();
      const fallbackId = String(obj.uuid ?? crypto.randomUUID());
      const messages = normalizeLineMessages(line).map((message, index) => ({
        ...message,
        id: message.id ?? (index === 0 ? fallbackId : `${fallbackId}#${index}`),
        ts: message.ts ?? now,
      }));
      indexSessionMessagesDirect(key, messages);
    } catch {}
  }
  function writeUser(text: string): void {
    const uuid = crypto.randomUUID();
    indexEnvelope({
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
    indexEnvelope({
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
    prompt: null,
    title: initialPrompt ? initialPrompt.slice(0, 72) : null,
    createdAt: Date.now(),
  });

  const queue: string[] = [];
  let draining = false;
  let closing = false;
  let turnActive = false;
  // True while OpenCode's `question` tool is waiting for a human answer.
  // busy is cleared for this window so the UI shows "needs answer" instead of
  // a permanent Working spinner; the underlying session.prompt() stays open.
  let waitingOnQuestion = false;
  // Ref object (not a bare let): TypeScript 7 narrows outer `let` bindings to
  // `never` inside `for await` loops when they are only mutated from nested
  // helpers, which broke openQuestionRef.current?.id. A mutable box keeps the type.
  const openQuestionRef: { current: OcPendingQuestion | null } = { current: null };
  let questionTimer: ReturnType<typeof setTimeout> | null = null;
  const publishDraft = makeDraftPublisher(key);

  function clearQuestionTimer(): void {
    if (questionTimer) {
      clearTimeout(questionTimer);
      questionTimer = null;
    }
  }

  function setWorkingBusy(): void {
    if (closing) return;
    waitingOnQuestion = false;
    patchEntry(key, {
      busy: true,
      prompt: null,
    });
  }

  function surfaceQuestion(pending: OcPendingQuestion): void {
    if (closing || !turnActive) return;
    if (pending.sessionID && pending.sessionID !== ocSessionId) return;
    const prompt = pendingToPrompt(pending);
    if (!prompt) return;
    openQuestionRef.current = pending;
    waitingOnQuestion = true;
    clearQuestionTimer();
    // Drop busy so the live view stops showing "Working"; publish the prompt
    // so the session card can render option buttons.
    patchEntry(key, {
      busy: false,
      prompt,
      draftText: null,
      draftUpdatedAt: null,
    });
    publishDraft("", true);
    indexSessionMessagesDirect(key, [
      {
        id: pending.id,
        role: "assistant",
        kind: "tool_use",
        text: `question: ${JSON.stringify({ questions: pending.questions }, null, 2)}`,
        ts: Date.now(),
      },
    ]);
    questionTimer = setTimeout(() => {
      if (openQuestionRef.current?.id === pending.id) {
        void handleDismissQuestion("timed out waiting for an answer");
      }
    }, QUESTION_TIMEOUT_MS);
  }

  function clearQuestionState(resumeBusy: boolean): void {
    clearQuestionTimer();
    openQuestionRef.current = null;
    waitingOnQuestion = false;
    if (closing) return;
    patchEntry(key, {
      prompt: null,
      ...(resumeBusy && turnActive ? { busy: true } : {}),
    });
  }

  async function handleAnswerQuestion(index: number): Promise<void> {
    const pending = openQuestionRef.current;
    if (!pending) return;
    const answers = answersForIndex(pending, index);
    const ok = await replyQuestion(serverUrl, pending.id, answers);
    if (!ok) {
      console.error(`opencode-aisdk-session: failed to reply to question ${pending.id}`);
      return;
    }
    const label = answers[0]?.[0] ?? `option ${index}`;
    indexSessionMessagesDirect(key, [
      {
        id: crypto.randomUUID(),
        role: "user",
        kind: "text",
        text: `[answered OpenCode question] ${label}`,
        ts: Date.now(),
      },
    ]);
    clearQuestionState(true);
  }

  async function handleDismissQuestion(reason = "dismissed"): Promise<void> {
    const pending = openQuestionRef.current;
    if (!pending) return;
    const ok = await rejectQuestion(serverUrl, pending.id);
    if (!ok) {
      console.error(`opencode-aisdk-session: failed to reject question ${pending.id}`);
      // Still clear local state so the UI unsticks even if OpenCode already
      // dropped the request (e.g. after interrupt).
    }
    indexSessionMessagesDirect(key, [
      {
        id: crypto.randomUUID(),
        role: "user",
        kind: "text",
        text: `[skipped OpenCode question] ${reason}`,
        ts: Date.now(),
      },
    ]);
    clearQuestionState(true);
  }

  async function syncPendingQuestions(): Promise<void> {
    if (!ocSessionId || closing) return;
    const all = await listPendingQuestions(serverUrl);
    const mine = all.filter((q) => !q.sessionID || q.sessionID === ocSessionId);
    if (!mine.length) {
      if (waitingOnQuestion) clearQuestionState(turnActive);
      return;
    }
    // Prefer the newest request for this session.
    const next = mine[mine.length - 1]!;
    if (openQuestionRef.current?.id === next.id) return;
    surfaceQuestion(next);
  }

  // Live draft + tool stream + question events. Cosmetically drives the live
  // view; the turn result still comes from session.prompt() below.
  void (async () => {
    try {
      const sub = await client.event.subscribe();
      const stream = (sub as { stream?: AsyncIterable<unknown>; data?: AsyncIterable<unknown> }).stream ??
        (sub as { data?: AsyncIterable<unknown> }).data;
      if (!stream) return;
      let draft = "";
      // Track last published snapshot per tool part so status transitions
      // (running → completed) re-index without spamming identical rows.
      const toolPartSnapshots = new Map<string, string>();
      for await (const raw of stream) {
        if (closing) break;
        const ev = raw as {
          type?: string;
          properties?: Record<string, unknown>;
        };
        const props = (ev?.properties ?? {}) as {
          part?: OcPart & { sessionID?: string };
          sessionID?: string;
          id?: string;
          questions?: OcQuestionInfo[];
        };
        const evSession = props.sessionID ?? props.part?.sessionID ?? null;

        // OpenCode question events (v1 + v2 names).
        if (
          (ev?.type === "question.asked" || ev?.type === "question.v2.asked") &&
          (!evSession || evSession === ocSessionId)
        ) {
          const id = props.id;
          const questions = props.questions;
          if (typeof id === "string" && Array.isArray(questions) && questions.length) {
            surfaceQuestion({ id, sessionID: ocSessionId ?? undefined, questions });
          } else {
            void syncPendingQuestions();
          }
          continue;
        }
        if (
          (ev?.type === "question.replied" ||
            ev?.type === "question.rejected" ||
            ev?.type === "question.v2.replied" ||
            ev?.type === "question.v2.rejected") &&
          (!evSession || evSession === ocSessionId)
        ) {
          const repliedId = typeof props.id === "string" ? props.id : null;
          const openId = openQuestionRef.current?.id ?? null;
          if (openId && (!repliedId || repliedId === openId)) {
            clearQuestionState(turnActive);
          }
          continue;
        }

        if (!turnActive) continue;
        const part = props.part;
        if (ev?.type === "message.part.updated" && part?.sessionID === ocSessionId) {
          if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
            // Prefer the latest assistant text blob for the draft; reasoning
            // only fills in when we don't have text yet.
            if (part.type === "text") {
              draft = part.text;
              publishDraft(draft);
            } else if (!draft && part.text) {
              publishDraft(part.text);
            }
          } else if (part.type === "tool") {
            const fallbackId = `${ocSessionId}:tool:${part.id ?? part.tool ?? "tool"}`;
            const id = part.id || fallbackId;
            const snap = `${part.tool ?? "tool"}|${part.state?.status ?? ""}|${JSON.stringify(part.state?.input ?? {})}`;
            if (toolPartSnapshots.get(id) !== snap) {
              toolPartSnapshots.set(id, snap);
              indexSessionMessagesDirect(key, [toolPartMessage(part, fallbackId)]);
            }
            // If a question tool starts, reconcile from /question (events can
            // lag behind the tool part).
            if (part.tool === "question" && part.state?.status === "running") {
              void syncPendingQuestions();
            }
          }
        }
        if (ev?.type === "session.idle" && (evSession == null || evSession === ocSessionId)) {
          draft = "";
        }
      }
    } catch {
      // Event stream is best-effort; drafts just won't animate if it drops.
    }
  })();

  // Backup poll: catch questions if the SSE event was missed (common after
  // reconnect / mid-turn subscribe). Cheap while a turn is active.
  const questionPoll = setInterval(() => {
    if (closing || !turnActive) return;
    void syncPendingQuestions();
  }, 1500);

  async function runTurn(prompt: string): Promise<void> {
    writeUser(prompt);
    turnActive = true;
    waitingOnQuestion = false;
    openQuestionRef.current = null;
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
      // Tools are already streamed into the index as they run — only commit the
      // final assistant text here to avoid duplicate tool_use rows.
      const content: unknown[] = [];
      if (text.trim()) content.push({ type: "text", text });
      else if (blocks.length) content.push(...blocks);
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
      clearQuestionState(false);
      publishDraft("", true);
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closing) {
        const prompt = queue.shift()!;
        setWorkingBusy();
        try {
          await runTurn(prompt);
        } finally {
          patchEntry(key, {
            busy: false,
            draftText: null,
            draftUpdatedAt: null,
            prompt: null,
          });
        }
      }
    } finally {
      draining = false;
    }
  }

  function interrupt(): void {
    if (!ocSessionId) return;
    // Reject any open question first so abort doesn't leave a zombie /question
    // entry (seen after the kimi-k3 hang).
    if (openQuestionRef.current) {
      void rejectQuestion(serverUrl, openQuestionRef.current.id);
      clearQuestionState(false);
    }
    if (!turnActive) return;
    void client.session
      .abort({ path: { id: ocSessionId }, query: { directory: cwd } })
      .catch(() => {});
  }

  function shutdown(): void {
    closing = true;
    clearInterval(questionPoll);
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
    } else if (cmd.type === "answer") {
      void handleAnswerQuestion(cmd.index);
    } else if (cmd.type === "dismiss") {
      void handleDismissQuestion("dismissed");
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
        clearInterval(questionPoll);
        clearInterval(exitWatch);
        clearQuestionTimer();
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
