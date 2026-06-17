// Running Claude Code sessions: enumerate live `claude` processes and tail
// their on-disk transcripts (~/.claude/projects/<proj>/<sessionId>.jsonl).
import { readdir, readlink } from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmuxTargetForPid } from "./tmux";
import { isManagedName } from "./managed";
import {
  listEntries as listAisdkEntries,
  isPidAlive,
  patchEntry as patchAisdkEntry,
  findEntryByAnyId as findAisdkEntryByAnyId,
} from "./aisdk-registry";
import { isClosing } from "./closing";
import { userAssignments } from "./users";
import { PATHS } from "./config";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const CODEX_SESSIONS_DIR = join(HOME, ".codex", "sessions");
const TITLE_MAX = 72;

export type SessionMsg = {
  // Stable per-line id (the transcript `uuid`). Lets the client dedup messages
  // that the live stream legitimately re-sends — e.g. the 40-message backlog
  // replayed on every EventSource reconnect — instead of re-rendering the
  // whole chunk again.
  id: string | null;
  role: string;
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  text: string;
  ts: number | null;
  // True only for a genuine upstream API-error turn (Claude Code stamps the
  // transcript line with `isApiErrorMessage: true` — e.g. a 400 credit-balance
  // block, a 404/synthetic model-unavailable turn, a 429 limit). Normal
  // assistant prose that merely *quotes* such an error is NOT flagged, which is
  // exactly what lets computeStatus avoid false "build paused" banners on
  // sessions that are debugging or summarizing those errors.
  apiError?: boolean;
};

export type Session = {
  agent: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode";
  pid: number;
  cmd: string;
  cwd: string | null;
  project: string;
  title: string;
  lastUserText: string | null;
  sessionId: string | null;
  startedAt: number | null;
  transcriptPath: string | null;
  lastActivityAt: number | null;
  last: SessionMsg | null;
  tmuxTarget: string | null;
  // tmux session name (the `name` in `name:0.0`) when targetable, and whether
  // lfg started this session itself (registry hit) — managed sessions get a
  // clean kill-session teardown and a badge in the UI.
  tmuxName: string | null;
  managed: boolean;
  // The user this session is tagged to (by tmux name), or null if unassigned.
  assignedUser: string | null;
  // Active model as a short alias (opus/sonnet/haiku/fable), resolved from the
  // latest assistant turn in the transcript (so it reflects a mid-session
  // `/model` switch, not just the launch flag), falling back to the launch
  // `--model` arg. null when not yet known (e.g. no assistant output yet).
  model: string | null;
  // Health of the session as far as the build is concerned. "ok" = running
  // normally; "blocked" = the session can't make forward progress until a
  // human acts (e.g. its model was retired/disabled, or the agent ran out of
  // API credits). Surfaced to the user as a "build paused" banner so a frozen
  // session reads as an explained pause, not a silent stall. See computeStatus.
  status: "ok" | "blocked";
  // Machine-readable reason when status === "blocked"; null when ok.
  statusReason: "model_unavailable" | "out_of_credits" | null;
  // Human-readable one-liner for the banner (e.g. the dead model id), or null.
  statusDetail: string | null;
};

// Classify a session's health from the most recent assistant turn. Claude Code
// emits a "<synthetic>"-model assistant turn (not a real inference) when it
// can't run — most commonly because the selected model was retired/disabled
// ("It may not exist or you may not have access to it. Run /model…"), which
// freezes the session: every subsequent turn replays the same error. We detect
// that (and the out-of-credits 400) so the UI can explain the pause instead of
// showing a spinner forever. `liveModel` is the raw model string off the last
// assistant line ("<synthetic>" for these synthetic errors).
function computeStatus(
  last: SessionMsg | null,
  liveModel: string | null,
): { status: "ok" | "blocked"; statusReason: Session["statusReason"]; statusDetail: string | null } {
  const text = last && last.role === "assistant" ? last.text : "";
  // Only a genuine upstream API-error turn can block the build. Claude Code
  // stamps those with `isApiErrorMessage: true` (surfaced here as last.apiError);
  // normal assistant prose that merely *quotes* an error string is not flagged.
  // Gating on this is what stops a session that's debugging / shipping a fix for
  // credit or model errors (its summary quotes "credit balance is too low" or
  // "Claude … is currently unavailable") from tripping a false "build paused".
  if (text && last?.apiError) {
    // Model retired / disabled / no access — the freeze the user sees. Match the
    // verbatim Claude Code error ("There's an issue with the selected model (X).
    // It may not exist or you may not have access to it. Run /model…") and the
    // Anthropic "Claude <name> is currently unavailable" notice. Kept specific so
    // a normal sentence containing "model" + "unavailable" can't trip it. The
    // synthetic-model marker (liveModel) is a corroborating signal when present.
    const modelErr =
      /issue with the selected model|may not have access to it\.?\s*run \/model|claude[\w.\s-]*is (currently )?unavailable|\bis no longer (available|supported)\b/i.test(
        text,
      );
    if (modelErr || (liveModel === "<synthetic>" && /\bmodel\b/i.test(text))) {
      const bad = text.match(/\(([^)]+)\)/)?.[1] ?? (liveModel && liveModel !== "<synthetic>" ? liveModel : null);
      return {
        status: "blocked",
        statusReason: "model_unavailable",
        statusDetail: bad ? `Model "${bad}" is unavailable` : "Selected model is unavailable",
      };
    }
    // Anthropic API credit exhaustion. Match the verbatim API error only —
    // NOT loose words like "billing" or "credits", which show up constantly in
    // normal dev/product chat ("add a billing page", "credit pack checkout")
    // and would mislabel healthy sessions as paused.
    if (/credit balance is too low|"type":\s*"(credit_balance_too_low|billing_error)"/i.test(text)) {
      return { status: "blocked", statusReason: "out_of_credits", statusDetail: "Out of API credits" };
    }
  }
  return { status: "ok", statusReason: null, statusDetail: null };
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

function listClaudeProcs(): { pid: number; cmd: string }[] {
  let out = "";
  try {
    const r = Bun.spawnSync(["pgrep", "-af", "claude"]);
    out = new TextDecoder().decode(r.stdout);
  } catch {
    return [];
  }
  const procs: { pid: number; cmd: string }[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2].trim();
    const first = cmd.split(/\s+/)[0] ?? "";
    // Only real `claude` invocations — not editors/greps that mention "claude".
    if (basename(first) !== "claude") continue;
    procs.push({ pid, cmd });
  }
  return procs;
}

function listCodexProcs(): { pid: number; cmd: string }[] {
  let out = "";
  try {
    const r = Bun.spawnSync(["pgrep", "-af", "codex"]);
    out = new TextDecoder().decode(r.stdout);
  } catch {
    return [];
  }
  const procs: { pid: number; cmd: string }[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2].trim();
    const first = cmd.split(/\s+/)[0] ?? "";
    if (basename(first) !== "codex") continue;
    procs.push({ pid, cmd });
  }
  return procs;
}

// Authoritative pid→session map. Claude writes ~/.claude/sessions/<pid>.json
// with the LIVE sessionId. The `--resume <uuid>` in the command line is the
// *pre-resume* id (Claude continues into a fresh transcript), so it points at a
// stale file. `procStart` lets us reject a recycled pid's leftover json.
function readPidSession(
  pid: number,
): { sessionId: string; cwd: string | null } | null {
  try {
    const raw = readFileSync(
      join(HOME, ".claude", "sessions", `${pid}.json`),
      "utf8",
    );
    const j = JSON.parse(raw) as {
      sessionId?: string;
      cwd?: string;
      procStart?: string;
    };
    if (!j.sessionId) return null;
    if (j.procStart) {
      // /proc/<pid>/stat field 22 = starttime; comm (field 2) may hold spaces
      // and parens, so index off the last ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[19] && fields[19] !== j.procStart) return null;
    }
    return { sessionId: j.sessionId, cwd: j.cwd ?? null };
  } catch {
    return null;
  }
}

// Resolve a live claude pid to its sessionId via the authoritative pidfile.
// Returns null until claude has written ~/.claude/sessions/<pid>.json.
export function sessionIdForPid(pid: number): string | null {
  return readPidSession(pid)?.sessionId ?? null;
}

function projectName(cwd: string | null): string {
  if (!cwd) return "—";
  return cwd.replace(/[/.]/g, "-").replace(/^-/, "");
}

// User-set title overrides, keyed by sessionId (data/session-titles.json).
export async function readTitleOverrides(): Promise<Record<string, string>> {
  try {
    const f = Bun.file(PATHS.sessionTitles);
    if (!(await f.exists())) return {};
    return (await f.json()) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  const all = await readTitleOverrides();
  const t = title.trim();
  if (t) all[sessionId] = t.slice(0, 200);
  else delete all[sessionId]; // empty title clears the override
  await Bun.write(PATHS.sessionTitles, JSON.stringify(all, null, 2));
}

// Claude's /resume picker titles a session by its first real user prompt; mirror
// that. Scan from the top, skipping meta rows and command/caveat wrappers
// (which start with "<"), and return the first prose line, truncated.
async function firstPromptTitle(path: string): Promise<string | null> {
  try {
    const text = await Bun.file(path).slice(0, 256 * 1024).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let x: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
      try {
        x = JSON.parse(line);
      } catch {
        continue;
      }
      const cm = normalizeCodexLine(line);
      if (cm?.role === "user" && cm.kind === "text") {
        const t = stripConversationPrefix(cm.text).trim().replace(/\s+/g, " ");
        if (t && !t.startsWith("<"))
          return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + "…" : t;
      }
      if (x.type !== "user" || x.isMeta) continue;
      const c = x.message?.content;
      let t: string | null = null;
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) {
        const p = (c as Array<{ type?: string; text?: string }>).find(
          (e) => e?.type === "text" && typeof e.text === "string",
        );
        t = p?.text ?? null;
      }
      if (!t) continue;
      t = stripHumanPrefix(t.trim().replace(/\s+/g, " "));
      if (!t || t.startsWith("<")) continue;
      return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + "…" : t;
    }
  } catch {}
  return null;
}

function candidateDirs(cwd: string): string[] {
  // claude maps cwd to a dir name by replacing path separators; try the
  // common encodings so bare sessions still resolve.
  const slash = cwd.replace(/\//g, "-");
  const dots = cwd.replace(/[/.]/g, "-");
  return [...new Set([slash, dots])];
}

async function findTranscriptById(id: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(PROJECTS_DIR, d, `${id}.jsonl`);
    if (await Bun.file(p).exists()) return p;
  }
  return null;
}

async function codexRolloutFiles(): Promise<string[]> {
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
          if (f.endsWith(".jsonl")) out.push(join(CODEX_SESSIONS_DIR, y, m, d, f));
        }
      }
    }
  }
  return out;
}

async function findCodexTranscriptById(id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  for (const p of await codexRolloutFiles()) {
    if (p.includes(id)) return p;
  }
  return null;
}

type CodexThread = {
  id: string;
  path: string;
  cwd: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  firstUserText: string | null;
};

async function codexThreads(): Promise<CodexThread[]> {
  const out: CodexThread[] = [];
  for (const path of await codexRolloutFiles()) {
    try {
      const first = (await Bun.file(path).slice(0, 128 * 1024).text()).split("\n")[0];
      if (!first) continue;
      const row = JSON.parse(first) as {
        type?: string;
        payload?: { id?: string; cwd?: string; timestamp?: string };
      };
      const id = row.payload?.id ?? path.match(UUID)?.[0] ?? null;
      if (row.type !== "session_meta" || !id) continue;
      let updatedAt: number | null = null;
      try {
        updatedAt = statSync(path).mtimeMs;
      } catch {}
      out.push({
        id,
        path,
        cwd: row.payload?.cwd ?? null,
        createdAt: row.payload?.timestamp ? Date.parse(row.payload.timestamp) : null,
        updatedAt,
        firstUserText: await firstUserTextFromTop(path),
      });
    } catch {}
  }
  return out;
}

async function firstUserTextFromTop(path: string): Promise<string | null> {
  try {
    const text = await Bun.file(path).slice(0, 256 * 1024).text();
    for (const line of text.split("\n")) {
      const m = normalizeCodexLine(line);
      if (m?.role === "user" && m.kind === "text") return m.text.trim();
    }
  } catch {}
  return null;
}

function codexPromptFromCmd(cmd: string): string | null {
  const m = cmd.match(/\s--\s+([\s\S]+)$/);
  return m?.[1]?.trim() || null;
}

function samePrompt(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  return clean(a) === clean(b);
}

function promptStartsWithTitle(prompt: string | null, title: string | null | undefined): boolean {
  if (!prompt || !title) return false;
  const clean = (s: string) => stripConversationPrefix(s).replace(/\s+/g, " ").trim();
  const p = clean(prompt);
  const t = clean(title);
  return !!t && (p === t || p.startsWith(t));
}

// How far an unclaimed transcript may lag the freshest transcript in the same
// cwd and still be trusted as a live process's current session. A running
// `claude` writes its transcript continuously, so the session a pid is on is
// (near) the freshest file in that cwd; a much older "newest unclaimed" file is
// almost certainly a stale, unrelated session and must NOT be guess-bound.
const FALLBACK_FRESHNESS_MS = 10 * 60_000;

async function newestUnclaimedInCwd(
  cwd: string,
  claimed: Set<string>,
): Promise<{ path: string; id: string } | null> {
  let best: { path: string; id: string; mtime: number } | null = null;
  let newestAny = 0; // freshest transcript regardless of claim status
  for (const dir of candidateDirs(cwd)) {
    const abs = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = await readdir(abs);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      let mtime = 0;
      try {
        mtime = statSync(join(abs, f)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime > newestAny) newestAny = mtime;
      const id = f.replace(/\.jsonl$/, "");
      if (claimed.has(id)) continue;
      if (!best || mtime > best.mtime) best = { path: join(abs, f), id, mtime };
    }
  }
  if (!best) return null;
  // Don't silently bind a live pid to a stale, unrelated transcript — that
  // mis-attributes its pane (e.g. a "needs input" prompt) to the wrong session.
  if (newestAny - best.mtime > FALLBACK_FRESHNESS_MS) {
    console.warn(
      `[sessions] no confident session for cwd ${cwd}: newest unclaimed transcript ${best.id} is ${Math.round((newestAny - best.mtime) / 60000)}m staler than the freshest in this cwd — leaving unidentified`,
    );
    return null;
  }
  return { path: best.path, id: best.id };
}

function inferCodexThreadForHarness(
  e: { cwd: string; title?: string | null; createdAt: number },
  threads: CodexThread[],
  claimed: Set<string>,
): CodexThread | null {
  const minTime = (e.createdAt ?? 0) - 30_000;
  const matches = threads
    .filter(
      (t) =>
        t.cwd === e.cwd &&
        !claimed.has(t.id) &&
        (t.createdAt ?? 0) >= minTime &&
        promptStartsWithTitle(t.firstUserText, e.title),
    )
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return matches[0] ?? null;
}

// AI-SDK backed providers can persist a speaker prefix ("Human:" for Claude,
// "User:" for Codex). Strip it so cards and transcript user messages read like
// normal CLI sessions.
function stripHumanPrefix(text: string): string {
  return stripConversationPrefix(text);
}

function stripConversationPrefix(text: string): string {
  return text.replace(/^(?:Human|User):[ \t]+/i, "");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((c: { type?: string; text?: string }) =>
        c?.type === "text" && typeof c.text === "string" ? c.text : "",
      )
      .filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return "";
}

function codexContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .map((c) =>
      (c?.type === "output_text" || c?.type === "input_text" || c?.type === "text") &&
      typeof c.text === "string"
        ? c.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function codexOutputText(output: unknown): string {
  if (typeof output === "string") return output.trim();
  const content = codexContentText(output).trim();
  if (content) return content;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function blockId(id: string | null, idx: number): string | null {
  if (!id) return null;
  return idx === 0 ? id : `${id}#${idx}`;
}

function describeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function codexLineId(
  x: { timestamp?: string; type?: string; payload?: { type?: string; call_id?: string } },
  text: string,
): string | null {
  const ts = x.timestamp ?? "";
  const kind = x.payload?.type ?? x.type ?? "";
  const call = x.payload?.call_id ?? "";
  const body = text.slice(0, 48);
  return ts || kind || call || body ? `${ts}:${kind}:${call}:${body}` : null;
}

function normalizeCodexLine(line: string): SessionMsg | null {
  let x: {
    timestamp?: string;
    type?: string;
    payload?: {
      type?: string;
      role?: string;
      content?: unknown;
      message?: string;
      name?: string;
      arguments?: string;
      output?: string;
      summary?: Array<{ text?: string }>;
      call_id?: string;
      phase?: string;
    };
  };
  try {
    x = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = x.timestamp ? Date.parse(x.timestamp) : null;
  const p = x.payload;
  if (!p) return null;

  if (x.type === "event_msg" && p.type === "user_message" && p.message?.trim()) {
    const text = stripConversationPrefix(p.message.trim());
    return { id: codexLineId(x, text), role: "user", kind: "text", text, ts };
  }
  if (x.type === "event_msg" && p.type === "agent_message") return null;
  if (x.type !== "response_item") return null;

  if (p.type === "message") {
    const role = p.role || "assistant";
    if (role === "system" || role === "developer" || role === "user") return null;
    const text = codexContentText(p.content).trim();
    if (!text) return null;
    return { id: codexLineId(x, text), role, kind: "text", text, ts };
  }
  if (p.type === "reasoning") {
    const text = (p.summary ?? [])
      .map((s) => s.text)
      .filter((s): s is string => !!s?.trim())
      .join("\n")
      .trim();
    if (!text) return null;
    return { id: codexLineId(x, text), role: "assistant", kind: "thinking", text, ts };
  }
  if (p.type === "function_call") {
    const args = p.arguments ? `: ${p.arguments}` : "";
    const text = `${p.name ?? "tool"}${args}`;
    return { id: codexLineId(x, text), role: "assistant", kind: "tool_use", text, ts };
  }
  if (p.type === "function_call_output") {
    const text = codexOutputText(p.output) || "(result)";
    return { id: codexLineId(x, text), role: "tool", kind: "tool_result", text, ts };
  }
  return null;
}

export function normalizeLine(line: string): SessionMsg | null {
  return normalizeLineMessages(line)[0] ?? null;
}

export function normalizeLineMessages(line: string): SessionMsg[] {
  try {
    return normalizeLineUnsafe(line);
  } catch {
    return [];
  }
}

function normalizeLineUnsafe(line: string): SessionMsg[] {
  const codex = normalizeCodexLine(line);
  if (codex) return [codex];

  let x: {
    type?: string;
    timestamp?: string;
    uuid?: string;
    isApiErrorMessage?: boolean;
    message?: { role?: string; content?: unknown };
  };
  try {
    x = JSON.parse(line);
  } catch {
    return [];
  }
  if (x.type !== "assistant" && x.type !== "user" && x.type !== "system")
    return [];
  const m = x.message;
  if (!m) return [];
  const ts = x.timestamp ? Date.parse(x.timestamp) : null;
  const id = x.uuid ?? null;
  const role = m.role || x.type;
  // Genuine upstream API-error turn (vs. prose that merely quotes an error).
  const apiError = x.isApiErrorMessage === true ? true : undefined;
  if (typeof m.content === "string") {
    if (!m.content.trim()) return [];
    const text = role === "user" ? stripHumanPrefix(m.content) : m.content;
    return [{ id, role, kind: "text", text, ts, apiError }];
  }
  if (Array.isArray(m.content)) {
    const arr = m.content as Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
    }>;
    const msgs: SessionMsg[] = [];
    arr.forEach((c, idx) => {
      if (c.type === "text" && c.text) {
        const text = role === "user" ? stripHumanPrefix(c.text) : c.text;
        msgs.push({ id: blockId(id, idx), role, kind: "text", text, ts, apiError });
        return;
      }
      if (c.type === "thinking") {
        msgs.push({
          id: blockId(id, idx),
          role,
          kind: "thinking",
          text: c.thinking || "(thinking)",
          ts,
        });
        return;
      }
      if (c.type === "tool_use") {
        const input = describeInput(c.input);
        msgs.push({
          id: blockId(id, idx),
          role,
          kind: "tool_use",
          text: input ? `${c.name ?? "tool"}: ${input}` : `${c.name ?? "tool"}`,
          ts,
        });
        return;
      }
      if (c.type === "tool_result") {
        msgs.push({
          id: blockId(id, idx),
          role,
          kind: "tool_result",
          text: extractText(c.content) || "(result)",
          ts,
        });
      }
    });
    return msgs;
  }
  return [];
}

// Last genuine user prompt — scan the tail backwards, skipping meta rows and
// command/caveat wrappers (lines starting with "<"). Truncated for the card.
async function lastUserText(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    const start = Math.max(0, size - 256 * 1024);
    const text = await file.slice(start).text();
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let x: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
      try {
        x = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const cm = normalizeCodexLine(lines[i]);
      if (cm?.role === "user" && cm.kind === "text") {
        const t = stripConversationPrefix(cm.text).trim().replace(/\s+/g, " ");
        if (t && !t.startsWith("<")) return t.length > 140 ? t.slice(0, 139) + "…" : t;
      }
      if (x.type !== "user" || x.isMeta) continue;
      let t = extractText(x.message?.content);
      if (!t) continue;
      t = stripHumanPrefix(t.trim().replace(/\s+/g, " "));
      if (!t || t.startsWith("<")) continue;
      return t.length > 140 ? t.slice(0, 139) + "…" : t;
    }
  } catch {}
  return null;
}

// Collapse a full model id (e.g. "claude-opus-4-8", "claude-3-5-haiku-...") to
// the short alias lfg uses everywhere (the same tokens the `/model` command
// and the model picker speak). Returns the raw value if it matches no family.
function modelAlias(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = id.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable")) return "fable";
  return id;
}

// The model of the most recent assistant turn. Claude stamps every assistant
// line with `message.model`, so the tail tells us the *live* model even after a
// mid-session `/model` switch (the launch `--model` arg goes stale). Returns
// null for a session that hasn't produced an assistant turn yet.
async function lastAssistantModel(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    const start = Math.max(0, size - 256 * 1024);
    const text = await file.slice(start).text();
    const lines = text.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let x: { type?: string; message?: { model?: string } };
      try {
        x = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (x.type === "assistant" && x.message?.model) return x.message.model;
    }
  } catch {}
  return null;
}

async function previewLast(path: string): Promise<SessionMsg | null> {
  const file = Bun.file(path);
  const size = file.size;
  const start = Math.max(0, size - 32768);
  const text = await file.slice(start).text();
  const lines = text.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const msgs = normalizeLineMessages(lines[i]);
    if (msgs.length) return msgs[msgs.length - 1];
  }
  return null;
}

export async function listSessions(): Promise<Session[]> {
  // Drop just-closed sessions up front (see closing.ts): /close kills the
  // process but it lingers for a poll or two, so without this a stopped session
  // flickers back into the list until pgrep stops seeing it.
  // Live "aisdk" harness sessions (the AI-SDK driven kind). Each harness drives a
  // child `claude` process via the SDK, which pgrep would otherwise surface as a
  // phantom duplicate session — filter those out by parent pid (and, as a
  // backstop, by the aisdk sessionId) so only the single aisdk session shows.
  const aisdkEntries = listAisdkEntries().filter((e) => isPidAlive(e.harnessPid));
  const harnessPids = new Set(aisdkEntries.map((e) => e.harnessPid));
  const aisdkSessionIds = new Set(aisdkEntries.map((e) => e.sessionId));
  const claudeProcs = listClaudeProcs().filter(
    (p) => !isClosing(p.pid) && !harnessPids.has(ppidOf(p.pid) ?? -1),
  );
  const enriched = await Promise.all(
    claudeProcs.map(async (p) => {
      let cwd: string | null = null;
      let startedAt: number | null = null;
      try {
        cwd = await readlink(`/proc/${p.pid}/cwd`);
      } catch {}
      try {
        startedAt = statSync(`/proc/${p.pid}`).ctimeMs;
      } catch {}
      // Prefer the authoritative ~/.claude/sessions/<pid>.json; the --resume
      // arg is stale and the newest-unclaimed heuristic can't disambiguate
      // multiple concurrent sessions sharing one cwd.
      const ps = readPidSession(p.pid);
      let sessionId: string | null = ps?.sessionId ?? null;
      // Authoritative = pid→sessionId came from the pidfile, so the live pane
      // we resolve for this pid is *known* to be running this session. The
      // --resume arg and the newest-unclaimed heuristic are guesses: the pane
      // may actually be running a different session (e.g. a long-lived
      // bare-`claude` that has moved on to other work). We only trust the
      // tmux target — for prompt detection and send-keys — when authoritative.
      const authoritative = !!ps?.sessionId;
      if (!sessionId) {
        const sm = p.cmd.match(
          new RegExp(`(?:--resume|-r)\\s+(${UUID.source})`),
        );
        sessionId = sm ? sm[1] : null;
      }
      if (ps?.cwd) cwd = ps.cwd;
      return { ...p, cwd, startedAt, sessionId, authoritative };
    }),
  );

  const claimed = new Set<string>(
    enriched.filter((e) => e.sessionId).map((e) => e.sessionId as string),
  );
  // Reserve aisdk transcripts so the newest-unclaimed-in-cwd heuristic can't
  // bind an unrelated bare `claude` in the same cwd to an aisdk session's
  // (freshly written) transcript — which would surface it as a phantom claude
  // duplicate of the aisdk session.
  for (const id of aisdkSessionIds) claimed.add(id);

  const overrides = await readTitleOverrides();
  const assigns = userAssignments();
  const out: Session[] = [];
  for (const e of enriched) {
    let transcriptPath: string | null = null;
    let sessionId = e.sessionId;
    // Backstop for the phantom-child filter above: if this claude proc resolved
    // to an aisdk session's id, it's the harness's child — skip it (the aisdk
    // session is added separately with its own control plane).
    if (sessionId && aisdkSessionIds.has(sessionId)) continue;
    if (sessionId) {
      transcriptPath = await findTranscriptById(sessionId);
    } else if (e.cwd) {
      const r = await newestUnclaimedInCwd(e.cwd, claimed);
      if (r) {
        transcriptPath = r.path;
        sessionId = r.id;
        claimed.add(r.id);
      }
    }
    let last: SessionMsg | null = null;
    let lastActivityAt: number | null = null;
    let lastUser: string | null = null;
    let liveModel: string | null = null;
    if (transcriptPath) {
      try {
        lastActivityAt = statSync(transcriptPath).mtimeMs;
      } catch {}
      last = await previewLast(transcriptPath).catch(() => null);
      lastUser = await lastUserText(transcriptPath).catch(() => null);
      liveModel = await lastAssistantModel(transcriptPath).catch(() => null);
    }
    // Prefer the transcript's live model; fall back to the launch `--model` arg
    // (always present on a lfg-managed session, so the badge shows instantly
    // before the first assistant turn).
    const model = modelAlias(liveModel) ?? modelAlias(e.cmd.match(/--model\s+(\S+)/)?.[1]);
    const health = computeStatus(last, liveModel);
    const project = projectName(e.cwd);
    let title = (sessionId && overrides[sessionId]) || null;
    if (!title && transcriptPath) title = await firstPromptTitle(transcriptPath);
    if (!title) title = e.cwd ? basename(e.cwd) : project;
    const tmuxTarget =
      isHeadless(e.cmd) || !e.authoritative ? null : tmuxTargetForPid(e.pid);
    const tmuxName = tmuxTarget ? tmuxTarget.split(":")[0] : null;
    out.push({
      agent: "claude",
      pid: e.pid,
      cmd: e.cmd,
      cwd: e.cwd,
      project,
      title,
      lastUserText: lastUser,
      sessionId,
      startedAt: e.startedAt,
      transcriptPath,
      lastActivityAt,
      last,
      // A headless `claude -p` (the report runner, or a dispatched agent
      // before it moved to its own tmux session) is a *descendant* of
      // whatever pane lfg runs in, so walking its parent chain resolves to
      // that unrelated pane. It has no TUI to drive — never give it a target.
      // We also withhold the target when the sessionId was *guessed* (no
      // pidfile): the resolved transcript and the live pane can be two
      // different conversations, so a prompt read from / message sent to that
      // pane would hit the wrong session.
      tmuxTarget,
      tmuxName,
      managed: isManagedName(tmuxName),
      assignedUser: tmuxName ? (assigns[tmuxName] ?? null) : null,
      model,
      status: health.status,
      statusReason: health.statusReason,
      statusDetail: health.statusDetail,
    });
  }

  const codex = await codexThreads();
  const claimedCodex = new Set<string>();
  // codex-aisdk harnesses each spawn a `codex app-server --listen stdio://`
  // child that pgrep WILL surface (basename is `codex`). It's the AI-SDK
  // session's engine, not a standalone TUI codex — so (1) skip the app-server
  // process below, and (2) reserve the codex-aisdk threadIds here so the
  // cwd+prompt fallback can't bind one of their rollout transcripts to an
  // unrelated bare codex in the same cwd. Both guard against the codex-aisdk
  // session being listed twice (once here as a phantom, once via the registry).
  for (const e of aisdkEntries) {
    if (e.agent === "codex" && e.threadId) claimedCodex.add(e.threadId);
  }
  for (const p of listCodexProcs()) {
    if (isClosing(p.pid)) continue; // just-closed — keep it out of the list
    // The app-server child of a codex-aisdk harness — not a user-facing codex
    // session. Its argv is `codex app-server --listen stdio://` (no resume id,
    // no `--` prompt), so it would otherwise show as a bare, transcript-less
    // phantom alongside the registry-driven codex-aisdk entry.
    if (/\bapp-server\b/.test(p.cmd)) continue;

    let cwd: string | null = null;
    let startedAt: number | null = null;
    try {
      cwd = await readlink(`/proc/${p.pid}/cwd`);
    } catch {}
    try {
      startedAt = statSync(`/proc/${p.pid}`).ctimeMs;
    } catch {}
    let sessionId = p.cmd.match(new RegExp(`(?:resume|fork)\\s+(${UUID.source})`))?.[1] ?? null;
    let thread = sessionId ? codex.find((t) => t.id === sessionId) : null;
    const prompt = codexPromptFromCmd(p.cmd);
    if (!thread && cwd && prompt) {
      const minTime = (startedAt ?? 0) - 30_000;
      thread =
        codex
          .filter(
            (t) =>
              t.cwd === cwd &&
              !claimedCodex.has(t.id) &&
              (t.createdAt ?? 0) >= minTime &&
              samePrompt(t.firstUserText, prompt),
          )
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
      if (thread) sessionId = thread.id;
    }
    if (thread) {
      claimedCodex.add(thread.id);
      if (thread.cwd) cwd = thread.cwd;
    }

    const transcriptPath = thread?.path ?? (sessionId ? await findCodexTranscriptById(sessionId) : null);
    let last: SessionMsg | null = null;
    let lastActivityAt: number | null = null;
    let lastUser: string | null = null;
    if (transcriptPath) {
      try {
        lastActivityAt = statSync(transcriptPath).mtimeMs;
      } catch {}
      last = await previewLast(transcriptPath).catch(() => null);
      lastUser = await lastUserText(transcriptPath).catch(() => null);
    }
    const project = projectName(cwd);
    let title = (sessionId && overrides[sessionId]) || null;
    if (!title && transcriptPath) title = await firstPromptTitle(transcriptPath);
    if (!title) title = cwd ? basename(cwd) : project;
    const tmuxTarget = tmuxTargetForPid(p.pid);
    const tmuxName = tmuxTarget ? tmuxTarget.split(":")[0] : null;
    out.push({
      agent: "codex",
      pid: p.pid,
      cmd: p.cmd,
      cwd,
      project,
      title,
      lastUserText: lastUser,
      sessionId,
      startedAt,
      transcriptPath,
      lastActivityAt,
      last,
      tmuxTarget,
      tmuxName,
      managed: isManagedName(tmuxName),
      assignedUser: tmuxName ? (assigns[tmuxName] ?? null) : null,
      // Codex model isn't switchable mid-session from lfg; surface the launch
      // arg verbatim (its names are catalog-driven, not the Claude aliases).
      model: p.cmd.match(/--model\s+(\S+)/)?.[1] ?? null,
      ...computeStatus(last, null),
    });
  }

  // "aisdk" sessions: headless AI-SDK harnesses. Discovery is registry-driven
  // (not pgrep) — the harness owns the control plane and the SDK writes the same
  // transcript JSONL as a normal claude session, so the live view reads it as-is.
  // tmuxName is set (supervisor → kill + managed badge) but tmuxTarget is null
  // (send/interrupt route through the command file, not the pane).
  for (const e of aisdkEntries) {
    const isCodex = e.agent === "codex";
    // opencode entries own a SELF-WRITTEN Claude-shaped transcript named by the
    // control-plane key (the harness writes no codex rollout) — so they discover
    // exactly like a Claude aisdk entry: transcript by sessionId, raw model.
    const isOpencode = e.agent === "opencode";
    // Claude/opencode entries name their transcript by the (deterministic)
    // sessionId. Codex entries persist a rollout under ~/.codex/sessions keyed by
    // the app-server threadId, which we only know after turn 1 — so the transcript
    // is null until then, and the live-view id is the threadId once available
    // (deep-links straight to the rollout) else the control-plane key.
    let codexThreadId = isCodex ? (e.threadId ?? null) : null;
    if (isCodex && !codexThreadId) {
      const inferred = inferCodexThreadForHarness(e, codex, claimedCodex);
      if (inferred) {
        codexThreadId = inferred.id;
        claimedCodex.add(inferred.id);
        patchAisdkEntry(e.sessionId, { threadId: inferred.id });
      }
    }
    const transcriptPath = isCodex
      ? codexThreadId
        ? await findCodexTranscriptById(codexThreadId)
        : null
      : await findTranscriptById(e.sessionId);
    const sessionId = isCodex ? (codexThreadId ?? e.sessionId) : e.sessionId;
    let last: SessionMsg | null = null;
    let lastActivityAt: number | null = null;
    let lastUser: string | null = null;
    if (transcriptPath) {
      try {
        lastActivityAt = statSync(transcriptPath).mtimeMs;
      } catch {}
      // The transcript helpers handle BOTH claude JSONL and codex rollouts
      // (normalizeCodexLine is tried first inside each), so they're safe for a
      // codex rollout path too. Guarded with .catch — never throw out of here.
      last = await previewLast(transcriptPath).catch(() => null);
      lastUser = await lastUserText(transcriptPath).catch(() => null);
    }
    const project = projectName(e.cwd);
    let title = overrides[sessionId] || null;
    if (!title && transcriptPath)
      title = await firstPromptTitle(transcriptPath).catch(() => null);
    if (!title) title = e.title || (e.cwd ? basename(e.cwd) : project);
    let startedAt: number | null = e.createdAt;
    try {
      startedAt = statSync(`/proc/${e.harnessPid}`).ctimeMs;
    } catch {}
    out.push({
      agent: isCodex ? "codex-aisdk" : isOpencode ? "opencode" : "aisdk",
      pid: e.harnessPid,
      cmd: isCodex
        ? `lfg codex-aisdk-session --model ${e.model}`
        : isOpencode
          ? `lfg opencode-aisdk-session --model ${e.model}`
          : `lfg aisdk-session --model ${e.model}`,
      cwd: e.cwd,
      project,
      title,
      lastUserText: lastUser,
      sessionId,
      startedAt,
      transcriptPath,
      lastActivityAt,
      last,
      // No pane I/O — but keep the supervisor name so kill + managed badge work.
      tmuxTarget: null,
      tmuxName: e.tmuxName || null,
      managed: isManagedName(e.tmuxName),
      assignedUser: e.tmuxName ? (assigns[e.tmuxName] ?? null) : null,
      // Codex slugs and opencode "provider/model" ids aren't Claude aliases —
      // pass them through raw. modelAlias would leave them unchanged anyway, but
      // be explicit about intent.
      model: isCodex || isOpencode ? e.model : modelAlias(e.model),
      ...computeStatus(last, null),
    });
  }
  // Order by start time (stable), not recency: sorting by lastActivityAt made
  // panes reshuffle every time a session became the most-active one. startedAt
  // never changes for a live session, so positions stay put and a new session
  // just appends at the end. sessionId breaks ties deterministically.
  out.sort(
    (a, b) =>
      (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
      (a.sessionId ?? "").localeCompare(b.sessionId ?? ""),
  );
  // Pane-collision guard: if two sessions resolve to the same pane we can't
  // tell which is the live foreground, so sending input would risk hitting the
  // wrong session. Drop the target from all of them rather than guess.
  const byTarget = new Map<string, Session[]>();
  for (const s of out) {
    if (!s.tmuxTarget) continue;
    const g = byTarget.get(s.tmuxTarget);
    if (g) g.push(s);
    else byTarget.set(s.tmuxTarget, [s]);
  }
  for (const [target, group] of byTarget) {
    if (group.length <= 1) continue;
    console.warn(
      `[sessions] ${group.length} sessions map to pane ${target} (pids ${group
        .map((g) => g.pid)
        .join(", ")}) — ambiguous, dropping target from all`,
    );
    for (const s of group) s.tmuxTarget = null;
  }
  return out;
}

// `claude -p` / `--print` runs headless (no TUI). pgrep gives us the full
// argv, so match the flag as a whole token.
function isHeadless(cmd: string): boolean {
  return /(^|\s)(-p|--print)(\s|$)/.test(cmd);
}

// Parent pid from /proc/<pid>/stat (4th field, after the parenthesized comm
// which may itself contain spaces/parens — so split on the LAST ')'.).
function ppidOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2); // skip ") " then state
    const fields = after.split(" ");
    return Number(fields[1]); // state, ppid, ...
  } catch {
    return null;
  }
}

export async function resolveTranscript(sessionId: string): Promise<string | null> {
  if (!UUID.test(sessionId)) return null;
  const entry = findAisdkEntryByAnyId(sessionId);
  let id = entry?.agent === "codex" && entry.threadId ? entry.threadId : sessionId;
  if (entry?.agent === "codex" && !entry.threadId) {
    const inferred = inferCodexThreadForHarness(entry, await codexThreads(), new Set());
    if (inferred) {
      id = inferred.id;
      patchAisdkEntry(entry.sessionId, { threadId: inferred.id });
    }
  }
  return (await findTranscriptById(id)) ?? findCodexTranscriptById(id);
}

// The cwd a claude transcript was recorded in. Every claude JSONL line carries a
// top-level `cwd`, so the first parseable line tells us where to relaunch a
// resumed session. Read only the head — the cwd is stable for the whole file.
export async function cwdForTranscript(path: string): Promise<string | null> {
  try {
    const text = await Bun.file(path).slice(0, 64 * 1024).text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const x = JSON.parse(line) as { cwd?: string };
        if (typeof x.cwd === "string" && x.cwd) return x.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

export type ResumableSession = {
  sessionId: string;
  cwd: string | null;
  project: string;
  title: string;
  lastActivityAt: number | null;
  lastUserText: string | null;
};

// Recently-active claude sessions that are NOT currently live — the closed /
// rebooted-away conversations a user can bring back with `claude --resume`.
// pgrep-based listSessions() only ever shows running procs, so after the box
// reboots (tmux server + every claude proc gone) the live list is empty even
// though all the transcripts survive on disk. This reads those transcripts so
// the UI can offer to resume one. Newest first, capped — enriching every
// historical transcript would be needlessly slow.
export async function listResumable(
  opts: { limit?: number; excludeIds?: Set<string> } = {},
): Promise<ResumableSession[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30));
  const exclude = opts.excludeIds ?? new Set<string>();
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  // Cheap first pass: collect (id, path, mtime) for every transcript, skipping
  // live ones, so we only pay the title/cwd read cost for the newest `limit`.
  const candidates: { id: string; path: string; mtime: number }[] = [];
  for (const d of dirs) {
    let files: string[];
    try {
      files = await readdir(join(PROJECTS_DIR, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.replace(/\.jsonl$/, "");
      if (!UUID.test(id) || exclude.has(id)) continue;
      const path = join(PROJECTS_DIR, d, f);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      candidates.push({ id, path, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const overrides = await readTitleOverrides();
  const out: ResumableSession[] = [];
  for (const c of candidates.slice(0, limit)) {
    const cwd = await cwdForTranscript(c.path).catch(() => null);
    let title = overrides[c.id] || null;
    if (!title) title = await firstPromptTitle(c.path).catch(() => null);
    if (!title) title = cwd ? basename(cwd) : "—";
    out.push({
      sessionId: c.id,
      cwd,
      project: projectName(cwd),
      title,
      lastActivityAt: c.mtime,
      lastUserText: await lastUserText(c.path).catch(() => null),
    });
  }
  return out;
}

// Recent normalized messages for an initial render (tail of the file).
export async function recentMessages(
  path: string,
  limit = 40,
  opts: { maxBytes?: number | null } = {},
): Promise<SessionMsg[]> {
  const file = Bun.file(path);
  const size = file.size;
  const maxBytes = opts.maxBytes === undefined ? 256 * 1024 : opts.maxBytes;
  const start = maxBytes == null ? 0 : Math.max(0, size - maxBytes);
  const text = await file.slice(start).text();
  const lines = text.split("\n").filter(Boolean);
  const msgs: SessionMsg[] = [];
  for (const l of lines) {
    msgs.push(...normalizeLineMessages(l));
  }
  return limit > 0 ? msgs.slice(-limit) : msgs;
}

// A prompt read straight from the transcript's structured AskUserQuestion
// tool_use block. Shape-compatible with tmux.ts's PanePrompt (question +
// numbered options) so the SSE prompt event and the client render it
// identically — the extra fields are additive and safely ignored by older
// clients.
export type PendingPrompt = {
  // Always "transcript" here — lets a consumer tell a structured prompt apart
  // from a pane-scraped one for debugging/telemetry.
  source: "transcript";
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{
    index: number; // 1-based — matches the digit you'd press in the TUI
    label: string;
    selected: boolean;
    description?: string;
  }>;
};

// Detect an AskUserQuestion that is still waiting for the user, read from the
// transcript's structured tool_use block rather than scraped from the tmux
// pane. This is dramatically more reliable: AskUserQuestion with option
// previews renders a side-by-side box layout (and multi-select / wrapped
// descriptions) that the pane parser mangles — or misses entirely, because in
// the preview layout no option line carries the `❯` cursor the scraper keys
// off, so no prompt surfaces at all. The transcript carries the exact question
// text and option labels with no ANSI or box-art.
//
// Scoped to AskUserQuestion on purpose: ExitPlanMode and permission/trust
// dialogs scrape cleanly (simple contiguous selectors with a live cursor) and
// their option set is TUI-generated — not in the transcript — so the pane stays
// the right source for those.
export async function pendingToolPrompt(
  path: string,
): Promise<PendingPrompt | null> {
  let text: string;
  try {
    const file = Bun.file(path);
    const size = file.size;
    // Tail only — a pending prompt is always near the end. 128KB comfortably
    // spans the last tool_use plus any tool_results after it. (If the slice
    // cuts the first line mid-object, JSON.parse drops it; the live prompt's
    // own line is intact at the tail.)
    const start = Math.max(0, size - 128 * 1024);
    text = await file.slice(start).text();
  } catch {
    return null;
  }
  // Walk forward tracking open AskUserQuestion tool_use ids; an id clears when
  // its tool_result lands. Whatever is still open at the end is unanswered.
  const open = new Map<string, unknown>();
  for (const l of text.split("\n")) {
    if (!l) continue;
    let x: { message?: { content?: unknown } };
    try {
      x = JSON.parse(l);
    } catch {
      continue;
    }
    const content = x?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<Record<string, unknown>>) {
      if (c?.type === "tool_use" && c?.name === "AskUserQuestion") {
        if (typeof c.id === "string") open.set(c.id, c.input);
      } else if (c?.type === "tool_result" && typeof c?.tool_use_id === "string") {
        open.delete(c.tool_use_id);
      }
    }
  }
  if (!open.size) return null;
  // The most-recently-opened still-pending question is the live one.
  const input = [...open.values()].pop() as
    | { questions?: Array<Record<string, unknown>> }
    | undefined;
  // AskUserQuestion can bundle several questions, surfaced one at a time; the
  // first is the one on screen for an unanswered call.
  const q = input?.questions?.[0];
  const options = Array.isArray(q?.options) ? q.options : null;
  if (!q || !options || !options.length) return null;
  return {
    source: "transcript",
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : undefined,
    multiSelect: !!q.multiSelect,
    options: (options as Array<Record<string, unknown>>).map((o, i) => ({
      index: i + 1,
      label: typeof o?.label === "string" ? o.label : String(o ?? ""),
      selected: false,
      description: typeof o?.description === "string" ? o.description : undefined,
    })),
  };
}

export async function messagePage(
  path: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<{
  messages: SessionMsg[];
  nextBefore: number | null;
  total: number;
}> {
  const all = await recentMessages(path, 0, { maxBytes: null });
  const limit = Math.max(1, Math.min(500, opts.limit ?? 220));
  const rawEnd = opts.before ?? all.length;
  const end = Math.max(0, Math.min(all.length, rawEnd));
  const start = Math.max(0, end - limit);
  return {
    messages: all.slice(start, end),
    nextBefore: start > 0 ? start : null,
    total: all.length,
  };
}
