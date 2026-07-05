// Running Claude Code sessions: enumerate live `claude` processes and tail
// their on-disk transcripts (~/.claude/projects/<proj>/<sessionId>.jsonl).
import { readdir, readlink } from "node:fs/promises";
import { statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { panePidForSession, tmuxHasSession, tmuxTargetForPid, capturePane, isBusy } from "./tmux";
import { isManagedName, listManaged, patchManaged, type ManagedSession } from "./managed";
import {
  listEntries as listAisdkEntries,
  isPidAlive,
  patchEntry as patchAisdkEntry,
  findEntryByAnyId as findAisdkEntryByAnyId,
  isEntryBusy as isAisdkEntryBusy,
} from "./aisdk-registry";
import { isClosing } from "./closing";
import { userAssignments } from "./users";
import { PATHS } from "./config";
import { homedir } from "node:os";
import { projectName } from "./projects";
import {
  cachedFingerprints,
  upsertResumableRows,
  pruneResumableExcept,
  queryResumableCache,
  type ResumableCacheRow,
  type ResumableQuery,
  type ResumableQueryResult,
} from "./resume-cache";

const HOME = process.env.HOME ?? homedir();
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const CODEX_SESSIONS_DIR = join(HOME, ".codex", "sessions");
const GROK_SESSIONS_DIR = join(HOME, ".grok", "sessions");
const GROK_ACTIVE_SESSIONS = join(HOME, ".grok", "active_sessions.json");
const TITLE_MAX = 72;
const TOOL_USE_TEXT_MAX = 4_000;
const TOOL_RESULT_TEXT_MAX = 8_000;

export type SessionMsg = {
  // Stable per-line id (the transcript `uuid`). Lets the client dedup messages
  // that the live stream legitimately re-sends — e.g. the 40-message backlog
  // replayed on every EventSource reconnect — instead of re-rendering the
  // whole chunk again.
  id: string | null;
  role: string;
  kind: "text" | "thinking" | "tool_use" | "tool_result" | "image";
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
  agent: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode" | "grok" | "hermes";
  pid: number;
  cmd: string;
  cwd: string | null;
  project: string;
  title: string;
  lastUserText: string | null;
  sessionId: string | null;
  nativeSessionId?: string | null;
  parentSessionId?: string | null;
  parentNativeSessionId?: string | null;
  parentAgent?: string | null;
  spawnedBy?: string | null;
  launching?: boolean;
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
  statusReason: "model_unavailable" | "out_of_credits" | "provider_auth" | "provider_error" | null;
  // Human-readable one-liner for the banner (e.g. the dead model id), or null.
  statusDetail: string | null;
  // Whether the session is actively working RIGHT NOW: for a tmux session, its
  // pane shows a running turn (isBusy); for a pane-less aisdk session, its
  // registry entry is mid-inference. Computed at list time so the UI can show
  // "working" from the /api/sessions call alone, without having to open a
  // transcript stream just to discover it. Always populated by listSessions()
  // (optional here only so the per-kind object literals don't each set it).
  busy?: boolean;
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
    if (/opencode turn failed/i.test(text)) {
      const authErr =
        /\b(forbidden|unauthorized|authentication|api key|invalid key|access denied|permission denied)\b/i.test(
          text,
        );
      return {
        status: "blocked",
        statusReason: authErr ? "provider_auth" : "provider_error",
        statusDetail: text.replace(/\s+/g, " ").trim().slice(0, 180),
      };
    }
  }
  return { status: "ok", statusReason: null, statusDetail: null };
}

function rememberNativeSession(m: ManagedSession | undefined, nativeId: string | null | undefined) {
  if (!m || !nativeId || m.nativeSessionId === nativeId) return;
  patchManaged(m.tmuxName, { nativeSessionId: nativeId, launchState: "running" });
}

function managedVisibleId(m: ManagedSession | undefined, nativeId: string | null | undefined): string | null {
  return m?.sessionId ?? nativeId ?? null;
}

function managedTitle(
  m: ManagedSession | undefined,
  visibleId: string | null,
  nativeId: string | null | undefined,
  overrides: Record<string, string>,
): string | null {
  return (
    (visibleId && overrides[visibleId]) ||
    (nativeId && overrides[nativeId]) ||
    m?.title ||
    null
  );
}

function managedLaunchRow(
  m: ManagedSession,
  overrides: Record<string, string>,
  assigns: Record<string, string>,
): Session | null {
  const sessionId = m.sessionId ?? m.nativeSessionId ?? null;
  if (!sessionId || !tmuxHasSession(m.tmuxName)) return null;
  const pid = panePidForSession(m.tmuxName) ?? 0;
  if (pid && isClosing(pid)) return null;
  const tmuxTarget = pid ? tmuxTargetForPid(pid) ?? `${m.tmuxName}:0.0` : `${m.tmuxName}:0.0`;
  const project = m.project || projectName(m.cwd, { repoRoot: m.repoRoot });
  const title =
    managedTitle(m, sessionId, m.nativeSessionId, overrides) ||
    (m.cwd ? basename(m.cwd) : project);
  const agent = m.agent ?? "claude";
  const fallbackCmd =
    agent === "codex" || agent === "codex-aisdk"
      ? `lfg ${agent} --model ${m.model ?? ""}`.trim()
      : agent === "grok"
        ? `grok --model ${m.model ?? ""}`.trim()
        : agent === "hermes"
          ? `hermes --model ${m.model ?? ""}`.trim()
          : agent === "opencode"
            ? `lfg opencode-aisdk-session --model ${m.model ?? ""}`.trim()
            : `lfg aisdk-session --model ${m.model ?? ""}`.trim();
  const cmd = pid ? readProcCmd(pid, fallbackCmd) : fallbackCmd;
  const model = m.model ?? cmd.match(/--model\s+(\S+)/)?.[1] ?? null;
  return {
    agent,
    pid,
    cmd,
    cwd: m.cwd,
    project,
    title,
    lastUserText: m.title ?? null,
    sessionId,
    nativeSessionId: m.nativeSessionId ?? null,
    parentSessionId: m.parentSessionId ?? null,
    parentNativeSessionId: m.parentNativeSessionId ?? null,
    parentAgent: m.parentAgent ?? null,
    spawnedBy: m.spawnedBy ?? null,
    launching: m.launchState === "launching",
    startedAt: m.createdAt,
    transcriptPath: null,
    lastActivityAt: m.createdAt,
    last: null,
    tmuxTarget: agent === "aisdk" || agent === "codex-aisdk" || agent === "opencode" ? null : tmuxTarget,
    tmuxName: m.tmuxName,
    managed: true,
    assignedUser: assigns[m.tmuxName] ?? null,
    model:
      agent === "codex" || agent === "codex-aisdk" || agent === "opencode" || agent === "grok" || agent === "hermes"
        ? model
        : modelAlias(model),
    ...computeStatus(null, null),
  };
}

function managedLineage(m: ManagedSession | undefined): Pick<
  Session,
  "parentSessionId" | "parentNativeSessionId" | "parentAgent" | "spawnedBy"
> {
  return {
    parentSessionId: m?.parentSessionId ?? null,
    parentNativeSessionId: m?.parentNativeSessionId ?? null,
    parentAgent: m?.parentAgent ?? null,
    spawnedBy: m?.spawnedBy ?? null,
  };
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

type GrokActiveSession = {
  session_id?: string;
  pid?: number;
  cwd?: string;
  opened_at?: string;
};

function readProcCmd(pid: number, fallback: string): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const cmd = raw.split("\0").filter(Boolean).join(" ").trim();
    return cmd || fallback;
  } catch {
    return fallback;
  }
}

function readGrokActiveSessions(): GrokActiveSession[] {
  try {
    const rows = JSON.parse(readFileSync(GROK_ACTIVE_SESSIONS, "utf8")) as unknown;
    return Array.isArray(rows) ? (rows as GrokActiveSession[]) : [];
  } catch {
    return [];
  }
}

export function grokSessionIdForPid(pid: number): string | null {
  for (const row of readGrokActiveSessions()) {
    if (row.pid === pid && typeof row.session_id === "string" && UUID.test(row.session_id))
      return row.session_id;
  }
  return null;
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
      const gm = normalizeGrokLineMessages(line).find((msg) => msg.role === "user" && msg.kind === "text");
      if (gm) {
        const t = gm.text.trim().replace(/\s+/g, " ");
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

async function findGrokTranscriptById(id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  let dirs: string[];
  try {
    dirs = await readdir(GROK_SESSIONS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const p = join(GROK_SESSIONS_DIR, dir, id, "chat_history.jsonl");
    if (await Bun.file(p).exists()) return p;
  }
  return null;
}

async function grokSummaryById(id: string): Promise<{
  generated_title?: string;
  current_model_id?: string;
  updated_at?: string;
} | null> {
  if (!UUID.test(id)) return null;
  let dirs: string[];
  try {
    dirs = await readdir(GROK_SESSIONS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const p = join(GROK_SESSIONS_DIR, dir, id, "summary.json");
    try {
      const f = Bun.file(p);
      if (await f.exists()) return (await f.json()) as {
        generated_title?: string;
        current_model_id?: string;
        updated_at?: string;
      };
    } catch {}
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

// A rollout's header (session_meta line + first user prompt) is written once at
// session start and never rewritten — rollouts are append-only. So the parse is
// a pure function of the path: cache it permanently and re-read only the cheap
// mtime each poll. Without this, every listSessions() re-read+parsed ~384KB of
// EVERY historical codex rollout (O(all codex sessions ever)) every 5 seconds.
type CodexHead = { id: string; cwd: string | null; createdAt: number | null; firstUserText: string | null };
const codexHeadCache = new Map<string, CodexHead | null>();

async function parseCodexHead(path: string): Promise<CodexHead | null> {
  try {
    const first = (await Bun.file(path).slice(0, 128 * 1024).text()).split("\n")[0];
    if (!first) return null;
    const row = JSON.parse(first) as {
      type?: string;
      payload?: { id?: string; cwd?: string; timestamp?: string };
    };
    const id = row.payload?.id ?? path.match(UUID)?.[0] ?? null;
    if (row.type !== "session_meta" || !id) return null;
    return {
      id,
      cwd: row.payload?.cwd ?? null,
      createdAt: row.payload?.timestamp ? Date.parse(row.payload.timestamp) : null,
      firstUserText: await firstUserTextFromTop(path),
    };
  } catch {
    return null;
  }
}

async function codexThreads(): Promise<CodexThread[]> {
  const out: CodexThread[] = [];
  for (const path of await codexRolloutFiles()) {
    let head = codexHeadCache.get(path);
    if (head === undefined) {
      head = await parseCodexHead(path);
      codexHeadCache.set(path, head);
    }
    if (!head) continue;
    let updatedAt: number | null = null;
    try {
      updatedAt = statSync(path).mtimeMs;
    } catch {}
    out.push({ id: head.id, path, cwd: head.cwd, createdAt: head.createdAt, updatedAt, firstUserText: head.firstUserText });
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

function compactToolText(text: string, max = TOOL_RESULT_TEXT_MAX): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.7);
  const tailLen = max - headLen;
  const omitted = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n\n...[${omitted.toLocaleString()} chars omitted from oversized tool output]...\n\n${text.slice(-tailLen)}`;
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
    const args = p.arguments ? `: ${compactToolText(p.arguments, TOOL_USE_TEXT_MAX)}` : "";
    const text = `${p.name ?? "tool"}${args}`;
    return { id: codexLineId(x, text), role: "assistant", kind: "tool_use", text, ts };
  }
  if (p.type === "function_call_output") {
    const text = compactToolText(codexOutputText(p.output) || "(result)");
    return { id: codexLineId(x, text), role: "tool", kind: "tool_result", text, ts };
  }
  return null;
}

function grokTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

function stripGrokUserQuery(text: string): string {
  const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)];
  const last = matches[matches.length - 1]?.[1]?.trim();
  return (last || text).trim();
}

function normalizeGrokLineMessages(line: string): SessionMsg[] {
  let x: {
    type?: string;
    content?: unknown;
    model_id?: string;
    tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
    tool_call_id?: string;
    summary?: Array<{ text?: string }>;
  };
  try {
    x = JSON.parse(line);
  } catch {
    return [];
  }

  if (x.type === "user") {
    const text = stripGrokUserQuery(grokTextContent(x.content));
    return text ? [{ id: null, role: "user", kind: "text", text, ts: null }] : [];
  }

  if (x.type === "assistant") {
    const msgs: SessionMsg[] = [];
    const text = grokTextContent(x.content).trim();
    if (text) msgs.push({ id: null, role: "assistant", kind: "text", text, ts: null });
    for (const call of x.tool_calls ?? []) {
      const args = call.arguments ? `: ${compactToolText(call.arguments, TOOL_USE_TEXT_MAX)}` : "";
      msgs.push({
        id: call.id ?? null,
        role: "assistant",
        kind: "tool_use",
        text: `${call.name ?? "tool"}${args}`,
        ts: null,
      });
    }
    return msgs;
  }

  if (x.type === "tool_result") {
    const text = compactToolText(grokTextContent(x.content).trim());
    return text
      ? [{ id: x.tool_call_id ?? null, role: "tool", kind: "tool_result", text, ts: null }]
      : [];
  }

  if (x.type === "reasoning") {
    const text = (x.summary ?? [])
      .map((s) => s.text)
      .filter((s): s is string => !!s?.trim())
      .join("\n")
      .trim();
    return text ? [{ id: null, role: "assistant", kind: "thinking", text, ts: null }] : [];
  }

  return [];
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
  const grok = normalizeGrokLineMessages(line);
  if (grok.length) return grok;

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
        const input = compactToolText(describeInput(c.input), TOOL_USE_TEXT_MAX);
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
          text: compactToolText(extractText(c.content) || "(result)"),
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

// --- transcript metadata caches ------------------------------------------
// Every transcript field listSessions() surfaces is a pure function of the
// file's bytes, and transcripts are append-only — so (mtimeMs, size) is a sound
// cache key. Under 5s polling the common case is an idle session whose file is
// untouched between polls; caching makes that cost zero reads instead of 3–4
// re-reads of up to 256KB each. Keep the existing helpers as the cold-path
// implementations so behaviour is identical on a cache miss.
type TailMeta = { last: SessionMsg | null; lastUser: string | null };
const tailMetaCache = new Map<string, { mtimeMs: number; size: number; meta: TailMeta }>();
const liveModelCache = new Map<string, { mtimeMs: number; size: number; model: string | null }>();
// The first real user prompt (the session title) is written once and never
// rewritten, so this is keyed by path alone and lives for the process lifetime.
const firstTitleCache = new Map<string, string>();

function fileSize(path: string): number {
  try {
    return Bun.file(path).size;
  } catch {
    return 0;
  }
}

// last message + last user prompt — shared by every agent loop.
async function transcriptTailMeta(path: string, mtimeMs: number): Promise<TailMeta> {
  const size = fileSize(path);
  const hit = tailMetaCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.meta;
  const meta: TailMeta = {
    last: await previewLast(path).catch(() => null),
    lastUser: await lastUserText(path).catch(() => null),
  };
  tailMetaCache.set(path, { mtimeMs, size, meta });
  return meta;
}

// live (most-recent-assistant-turn) model — only the claude loop needs it.
async function cachedLiveModel(path: string, mtimeMs: number): Promise<string | null> {
  const size = fileSize(path);
  const hit = liveModelCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.model;
  const model = await lastAssistantModel(path).catch(() => null);
  liveModelCache.set(path, { mtimeMs, size, model });
  return model;
}

async function cachedFirstTitle(path: string): Promise<string | null> {
  const hit = firstTitleCache.get(path);
  if (hit != null) return hit;
  const title = await firstPromptTitle(path).catch(() => null);
  // Only memoise a real title: a transcript can exist before its first prompt
  // is written, so a transient null must be retried (not pinned) next poll.
  if (title) firstTitleCache.set(path, title);
  return title;
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
  const managedSessions = listManaged();
  const managedByName = new Map(managedSessions.map((m) => [m.tmuxName, m]));
  const sessionProject = (cwd: string | null, tmuxName: string | null | undefined) => {
    const managed = tmuxName ? managedByName.get(tmuxName) : undefined;
    return managed?.project || projectName(cwd, { repoRoot: managed?.repoRoot });
  };
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
      const meta = await transcriptTailMeta(transcriptPath, lastActivityAt ?? 0);
      last = meta.last;
      lastUser = meta.lastUser;
      liveModel = await cachedLiveModel(transcriptPath, lastActivityAt ?? 0);
    }
    // Prefer the transcript's live model; fall back to the launch `--model` arg
    // (always present on a lfg-managed session, so the badge shows instantly
    // before the first assistant turn).
    const model = modelAlias(liveModel) ?? modelAlias(e.cmd.match(/--model\s+(\S+)/)?.[1]);
    const health = computeStatus(last, liveModel);
    // Resolve the pane this pid runs in up front; the trust check below decides
    // whether we hand it out for send-keys / prompt detection. The pane NAME is
    // still safe to use for matching the managed record either way.
    const rawTarget = isHeadless(e.cmd) ? null : tmuxTargetForPid(e.pid);
    const paneName = rawTarget ? rawTarget.split(":")[0] : null;
    const managedRec = paneName ? managedByName.get(paneName) : undefined;
    // Trust the pane target when the pidfile is authoritative OR the pane is one
    // lfg manages. For a managed session we ran `tmux new-session -s <name>`
    // ourselves, so the pane→session binding is deterministic (the whole premise
    // of managed.ts) and doesn't need claude's pidfile to have landed yet. This
    // is what makes a heavy `--resume` sendable DURING its long compaction: the
    // pidfile isn't authoritative for tens of seconds while it compacts, but we
    // still own the pane — withholding the target here is exactly what produced
    // "session is not in a tmux pane — cannot send" on every just-resumed big
    // session. (Non-managed attached sessions still require authoritative, so the
    // wrong-pid / ghost-pane protections are unchanged for them.)
    const tmuxTarget = rawTarget && (e.authoritative || !!managedRec) ? rawTarget : null;
    const tmuxName = tmuxTarget ? tmuxTarget.split(":")[0] : null;
    rememberNativeSession(managedRec, sessionId);
    const visibleSessionId = managedVisibleId(managedRec, sessionId);
    const cwd = managedRec?.cwd ?? e.cwd;
    const project = sessionProject(cwd, tmuxName);
    let title = managedTitle(managedRec, visibleSessionId, sessionId, overrides);
    if (!title && transcriptPath) title = await cachedFirstTitle(transcriptPath);
    if (!title) title = cwd ? basename(cwd) : project;
    out.push({
      agent: "claude",
      pid: e.pid,
      cmd: e.cmd,
      cwd,
      project,
      title,
      lastUserText: lastUser,
      sessionId: visibleSessionId,
      nativeSessionId: sessionId,
      ...managedLineage(managedRec),
      launching: managedRec?.launchState === "launching" && !sessionId,
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
      const meta = await transcriptTailMeta(transcriptPath, lastActivityAt ?? 0);
      last = meta.last;
      lastUser = meta.lastUser;
    }
    const tmuxTarget = tmuxTargetForPid(p.pid);
    const tmuxName = tmuxTarget ? tmuxTarget.split(":")[0] : null;
    const managedRec = tmuxName ? managedByName.get(tmuxName) : undefined;
    rememberNativeSession(managedRec, sessionId);
    const visibleSessionId = managedVisibleId(managedRec, sessionId);
    const project = sessionProject(cwd, tmuxName);
    let title = managedTitle(managedRec, visibleSessionId, sessionId, overrides);
    if (!title && transcriptPath) title = await cachedFirstTitle(transcriptPath);
    if (!title) title = cwd ? basename(cwd) : project;
    out.push({
      agent: "codex",
      pid: p.pid,
      cmd: p.cmd,
      cwd,
      project,
      title,
      lastUserText: lastUser,
      sessionId: visibleSessionId,
      nativeSessionId: sessionId,
      ...managedLineage(managedRec),
      launching: managedRec?.launchState === "launching" && !sessionId,
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

  const managedGrok = managedSessions.filter((m) => m.agent === "grok" && m.sessionId);
  const managedGrokByName = new Map(managedGrok.map((m) => [m.tmuxName, m]));
  const activeGrokTmux = new Set<string>();
  for (const g of readGrokActiveSessions()) {
    const grokSessionId = typeof g.session_id === "string" && UUID.test(g.session_id)
      ? g.session_id
      : null;
    const pid = typeof g.pid === "number" ? g.pid : null;
    if (!grokSessionId || !pid || !isPidAlive(pid) || isClosing(pid)) continue;

    let cwd: string | null = g.cwd ?? null;
    let startedAt: number | null = g.opened_at ? Date.parse(g.opened_at) : null;
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {}
    try {
      startedAt = statSync(`/proc/${pid}`).ctimeMs;
    } catch {}

    const tmuxTarget = tmuxTargetForPid(pid);
    const tmuxName = tmuxTarget ? tmuxTarget.split(":")[0] : null;
    if (tmuxName) activeGrokTmux.add(tmuxName);
    const managedRec = tmuxName ? managedGrokByName.get(tmuxName) : undefined;
    rememberNativeSession(managedRec, grokSessionId);
    const sessionId = managedRec?.sessionId ?? grokSessionId;
    const transcriptPath = await findGrokTranscriptById(grokSessionId);
    const summary = await grokSummaryById(grokSessionId);
    let last: SessionMsg | null = null;
    let lastActivityAt: number | null = summary?.updated_at ? Date.parse(summary.updated_at) : null;
    let lastUser: string | null = null;
    if (transcriptPath) {
      try {
        lastActivityAt = statSync(transcriptPath).mtimeMs;
      } catch {}
      const meta = await transcriptTailMeta(transcriptPath, lastActivityAt ?? 0);
      last = meta.last;
      lastUser = meta.lastUser;
    }

    const project = managedRec?.project || projectName(cwd, { repoRoot: managedRec?.repoRoot });
    let title = overrides[sessionId] || overrides[grokSessionId] || null;
    if (!title && summary?.generated_title) title = summary.generated_title;
    if (!title && transcriptPath) title = await cachedFirstTitle(transcriptPath);
    if (!title) title = cwd ? basename(cwd) : project;
    const cmd = readProcCmd(pid, `grok --model ${summary?.current_model_id ?? "grok-composer-2.5-fast"}`);

    out.push({
      agent: "grok",
      pid,
      cmd,
      cwd,
      project,
      title,
      lastUserText: lastUser,
      sessionId,
      nativeSessionId: grokSessionId,
      ...managedLineage(managedRec),
      launching: managedRec?.launchState === "launching" && !transcriptPath,
      startedAt,
      transcriptPath,
      lastActivityAt,
      last,
      tmuxTarget,
      tmuxName,
      managed: !!managedRec || (tmuxName ? isManagedName(tmuxName) : false),
      assignedUser: tmuxName ? (assigns[tmuxName] ?? null) : null,
      model: summary?.current_model_id ?? cmd.match(/--model\s+(\S+)/)?.[1] ?? null,
      ...computeStatus(last, null),
    });
  }

  for (const m of managedGrok) {
    if (activeGrokTmux.has(m.tmuxName) || !tmuxHasSession(m.tmuxName)) continue;
    const pid = panePidForSession(m.tmuxName);
    if (!pid || isClosing(pid)) continue;
    const tmuxTarget = tmuxTargetForPid(pid) ?? `${m.tmuxName}:0.0`;
    const cmd = readProcCmd(pid, "grok");
    const project = m.project || projectName(m.cwd, { repoRoot: m.repoRoot });
    out.push({
      agent: "grok",
      pid,
      cmd,
      cwd: m.cwd,
      project,
      title: overrides[m.sessionId!] || (m.cwd ? basename(m.cwd) : project),
      lastUserText: null,
      sessionId: m.sessionId!,
      nativeSessionId: m.nativeSessionId ?? null,
      ...managedLineage(m),
      launching: m.launchState === "launching",
      startedAt: m.createdAt,
      transcriptPath: null,
      lastActivityAt: m.createdAt,
      last: null,
      tmuxTarget,
      tmuxName: m.tmuxName,
      managed: true,
      assignedUser: assigns[m.tmuxName] ?? null,
      model: cmd.match(/--model\s+(\S+)/)?.[1] ?? null,
      ...computeStatus(null, null),
    });
  }

  for (const m of listManaged().filter((row) => row.agent === "hermes" && row.sessionId)) {
    if (!tmuxHasSession(m.tmuxName)) continue;
    const pid = panePidForSession(m.tmuxName);
    if (!pid || isClosing(pid)) continue;
    const tmuxTarget = tmuxTargetForPid(pid) ?? `${m.tmuxName}:0.0`;
    const cmd = readProcCmd(pid, "hermes");
    const project = m.project || projectName(m.cwd, { repoRoot: m.repoRoot });
    out.push({
      agent: "hermes",
      pid,
      cmd,
      cwd: m.cwd,
      project,
      title: overrides[m.sessionId!] || m.title || (m.cwd ? basename(m.cwd) : project),
      lastUserText: m.title ?? null,
      sessionId: m.sessionId!,
      nativeSessionId: m.nativeSessionId ?? null,
      ...managedLineage(m),
      launching: m.launchState === "launching",
      startedAt: m.createdAt,
      transcriptPath: null,
      lastActivityAt: m.createdAt,
      last: null,
      tmuxTarget,
      tmuxName: m.tmuxName,
      managed: true,
      assignedUser: assigns[m.tmuxName] ?? null,
      model: cmd.match(/--model\s+(\S+)/)?.[1] ?? null,
      ...computeStatus(null, null),
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
    const nativeSessionId = isCodex ? codexThreadId : e.sessionId;
    const managedRec = e.tmuxName ? managedByName.get(e.tmuxName) : undefined;
    rememberNativeSession(managedRec, nativeSessionId);
    const sessionId = managedVisibleId(managedRec, e.sessionId) ?? e.sessionId;
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
      const meta = await transcriptTailMeta(transcriptPath, lastActivityAt ?? 0);
      last = meta.last;
      lastUser = meta.lastUser;
    }
    const project = managedRec?.project || projectName(e.cwd, { repoRoot: managedRec?.repoRoot });
    let title = managedTitle(managedRec, sessionId, nativeSessionId, overrides);
    if (!title && transcriptPath) title = await cachedFirstTitle(transcriptPath);
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
      nativeSessionId,
      ...managedLineage(managedRec),
      launching: managedRec?.launchState === "launching" && !transcriptPath,
      startedAt,
      transcriptPath,
      lastActivityAt,
      last,
      // No pane I/O — but keep the supervisor name so kill + managed badge work.
      tmuxTarget: null,
      tmuxName: e.tmuxName || null,
      managed: !!managedRec || isManagedName(e.tmuxName),
      assignedUser: e.tmuxName ? (assigns[e.tmuxName] ?? null) : null,
      // Codex slugs and opencode "provider/model" ids aren't Claude aliases —
      // pass them through raw. modelAlias would leave them unchanged anyway, but
      // be explicit about intent.
      model: isCodex || isOpencode ? e.model : modelAlias(e.model),
      ...computeStatus(last, null),
    });
  }

  const representedManaged = new Set(
    out.map((s) => s.tmuxName).filter((name): name is string => !!name),
  );
  for (const m of managedSessions) {
    if (representedManaged.has(m.tmuxName)) continue;
    const row = managedLaunchRow(m, overrides, assigns);
    if (row) out.push(row);
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
  // Stamp the live "working" flag onto every session so the list call is
  // self-sufficient: the client can render which sessions are busy without
  // opening a transcript stream. Cheap — a tmux pane capture (a few ms each) or
  // an in-memory registry lookup — and it replaces N eager SSE connections.
  for (const s of out) s.busy = sessionBusy(s);
  return out;
}

// Live busy state for a single session, derived the same way the SSE stream
// derives it (so the list and the stream agree): a tmux session is busy when
// its pane shows a running turn; a pane-less aisdk session is busy when its
// registry entry is mid-inference. Defaults to false when state is unknown.
function sessionBusy(s: Session): boolean {
  try {
    if (s.launching) return true;
    if (s.tmuxTarget) {
      const pane = capturePane(s.tmuxTarget);
      return pane ? isBusy(pane) : false;
    }
    if (s.sessionId) {
      const entry = findAisdkEntryByAnyId(s.sessionId);
      if (entry) return isAisdkEntryBusy(entry);
    }
  } catch {}
  return false;
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
  const managed = listManaged().find(
    (m) => m.sessionId === sessionId || m.nativeSessionId === sessionId,
  );
  if (managed?.nativeSessionId && managed.nativeSessionId !== sessionId) {
    const native =
      (managed.agent === "grok"
        ? findGrokTranscriptById(managed.nativeSessionId)
        : managed.agent === "codex" || managed.agent === "codex-aisdk"
          ? await findCodexTranscriptById(managed.nativeSessionId)
          : await findTranscriptById(managed.nativeSessionId)) ??
      (await findTranscriptById(managed.nativeSessionId)) ??
      (await findCodexTranscriptById(managed.nativeSessionId)) ??
      findGrokTranscriptById(managed.nativeSessionId);
    if (native) return native;
    if (managed.cwd && managed.agent !== "codex" && managed.agent !== "codex-aisdk" && managed.agent !== "grok") {
      for (const d of candidateDirs(managed.cwd)) {
        return join(PROJECTS_DIR, d, `${managed.nativeSessionId}.jsonl`);
      }
    }
  }
  const managedGrok = listManaged().find((m) => m.agent === "grok" && m.sessionId === sessionId);
  if (managedGrok) {
    const pid = panePidForSession(managedGrok.tmuxName);
    const grokId = pid ? grokSessionIdForPid(pid) : null;
    if (grokId) return findGrokTranscriptById(grokId);
  }
  const entry = findAisdkEntryByAnyId(sessionId);
  let id = entry?.agent === "codex" && entry.threadId ? entry.threadId : sessionId;
  if (entry?.agent === "codex" && !entry.threadId) {
    const inferred = inferCodexThreadForHarness(entry, await codexThreads(), new Set());
    if (inferred) {
      id = inferred.id;
      patchAisdkEntry(entry.sessionId, { threadId: inferred.id });
    }
  }
  let p =
    (await findTranscriptById(id)) ?? (await findCodexTranscriptById(id)) ?? findGrokTranscriptById(id);
  if (p) return p;

  // For freshly-created headless "js" (aisdk/opencode) sessions we own the id and
  // the cwd (from the aisdk registry entry). Return the path the transcript *will*
  // be written to under ~/.claude/projects/... even if the .jsonl does not exist
  // on disk yet. This lets /api/live/stream establish a tailer immediately; pump
  // will deliver lines as soon as the harness/provider writes the first content.
  // (Codex-aisdk uses separate rollout paths and threadIds assigned after turn 1.)
  if (entry?.cwd && entry.agent !== "codex") {
    for (const d of candidateDirs(entry.cwd)) {
      const cand = join(PROJECTS_DIR, d, `${id}.jsonl`);
      return cand;
    }
  }
  return null;
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
  // Which engine the session was recorded with. "claude" resumes via the claude
  // CLI (`claude --resume`); "codex" resumes via a codex-aisdk harness keyed to
  // the rollout's threadId. The serve /resume endpoint branches on this.
  agent: "claude" | "codex";
};

// The cwd a codex rollout was recorded in. Codex stores it on the first
// `session_meta` line's payload (NOT a top-level `cwd` like claude), so the
// claude-oriented cwdForTranscript() can't read it. Used to relaunch a resumed
// codex session in its original directory.
export async function cwdForCodexTranscript(path: string): Promise<string | null> {
  try {
    const first = (await Bun.file(path).slice(0, 128 * 1024).text()).split("\n")[0];
    if (!first) return null;
    const row = JSON.parse(first) as { type?: string; payload?: { cwd?: string } };
    if (row.type === "session_meta" && typeof row.payload?.cwd === "string")
      return row.payload.cwd || null;
  } catch {}
  return null;
}

// Incrementally refresh the durable resumable cache (src/resume-cache.ts).
//
// pgrep-based listSessions() only ever shows running procs, so after the box
// reboots (tmux server + every claude proc gone) the live list is empty even
// though every transcript survives on disk. We scan those transcripts (plus the
// codex rollouts) so the UI can offer to resume one — but re-reading each file's
// title/cwd/last-message on every request is wasteful, so the enriched roster is
// cached in SQLite and only files whose mtime changed since the last scan are
// re-enriched. Repeat loads (and search/filter keystrokes) then run as cheap SQL.
let resumableRefreshAt = 0;
let resumableRefreshing: Promise<void> | null = null;
const RESUMABLE_REFRESH_THROTTLE_MS = 1500;
// Cap NEW enrich work per pass so the very first scan of a huge history returns
// a usable (newest-first) page fast; the tail backfills over later refreshes.
const RESUMABLE_ENRICH_BUDGET = 600;

async function refreshResumableCacheOnce(): Promise<void> {
  const fingerprints = cachedFingerprints();
  const overrides = await readTitleOverrides();
  const managedByCwd = new Map(listManaged().map((m) => [m.cwd, m]));
  const seen = new Set<string>();
  const changed: ResumableCacheRow[] = [];

  // Claude transcripts: cheap pass collects (id, path, mtime), newest first, so
  // the enrich budget is spent on the most recent unindexed files.
  let dirs: string[] = [];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {}
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
      if (!UUID.test(id)) continue;
      const path = join(PROJECTS_DIR, d, f);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      seen.add(id);
      candidates.push({ id, path, mtime });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  let budget = RESUMABLE_ENRICH_BUDGET;
  for (const c of candidates) {
    const prev = fingerprints.get(c.id);
    if (prev && prev.mtimeMs === c.mtime) continue; // unchanged -> keep cached row
    if (budget-- <= 0) break; // remainder backfills on the next refresh
    const cwd = await cwdForTranscript(c.path).catch(() => null);
    const managedRec = cwd ? managedByCwd.get(cwd) : undefined;
    let title = overrides[c.id] || null;
    if (!title) title = await firstPromptTitle(c.path).catch(() => null);
    if (!title) title = cwd ? basename(cwd) : "—";
    changed.push({
      sessionId: c.id,
      cwd,
      project: managedRec?.project || projectName(cwd, { repoRoot: managedRec?.repoRoot }),
      title,
      lastActivityAt: c.mtime,
      lastUserText: await lastUserText(c.path).catch(() => null),
      agent: "claude",
      path: c.path,
      mtimeMs: c.mtime,
    });
  }

  // Codex rollouts (~/.codex/sessions): codexThreads() already parses each
  // rollout's session_meta (id/cwd/title), so re-enriching is cheap — no budget.
  for (const t of await codexThreads().catch(() => [] as Awaited<ReturnType<typeof codexThreads>>)) {
    seen.add(t.id);
    const mtime = t.updatedAt ?? t.createdAt ?? 0;
    const prev = fingerprints.get(t.id);
    if (prev && prev.mtimeMs === mtime) continue;
    const managedRec = t.cwd ? managedByCwd.get(t.cwd) : undefined;
    changed.push({
      sessionId: t.id,
      cwd: t.cwd,
      project: managedRec?.project || projectName(t.cwd, { repoRoot: managedRec?.repoRoot }),
      title: overrides[t.id] || t.firstUserText || (t.cwd ? basename(t.cwd) : "—"),
      lastActivityAt: t.updatedAt ?? t.createdAt,
      lastUserText: t.firstUserText,
      agent: "codex",
      path: t.path,
      mtimeMs: mtime,
    });
  }

  upsertResumableRows(changed);
  pruneResumableExcept(seen);
}

// Refresh at most once per throttle window (unless forced); concurrent callers
// share the in-flight scan. Awaited by queryResumable so the first-ever request
// still populates the cache before it reads.
export async function refreshResumableCache(opts: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (resumableRefreshing) return resumableRefreshing;
  if (!opts.force && now - resumableRefreshAt < RESUMABLE_REFRESH_THROTTLE_MS) return;
  resumableRefreshing = refreshResumableCacheOnce()
    .catch((err) => {
      console.warn(
        `[resume-cache] refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      resumableRefreshAt = Date.now();
      resumableRefreshing = null;
    });
  return resumableRefreshing;
}

// The rich query the picker uses: search + agent/project filters + facet counts,
// all served from the SQLite cache.
//
// The scan is kept OFF the hot path: we only block on a refresh when the cache
// is completely cold (first ever call), so the first open populates. Otherwise
// the query is served immediately from SQLite (sub-ms) and a refresh is kicked
// off in the background — the roster is at most one throttle window stale, which
// is fine for a "recent sessions" list.
export async function queryResumable(opts: ResumableQuery = {}): Promise<ResumableQueryResult> {
  if (resumableRefreshAt === 0) {
    // Cold cache: block once so the first open returns a populated list. If a
    // startup warm is already in flight, refreshResumableCache() joins it rather
    // than starting a second scan.
    await refreshResumableCache({ force: true });
  } else {
    // Warm: serve from SQLite immediately, refresh in the background (throttled).
    void refreshResumableCache();
  }
  return queryResumableCache(opts);
}

// Back-compat thin wrapper: newest-first array only (used by the transcript
// indexer). Same shape listResumable has always returned.
export async function listResumable(
  opts: { limit?: number; excludeIds?: Set<string> } = {},
): Promise<ResumableSession[]> {
  const { sessions } = await queryResumable(opts);
  return sessions;
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
  if (limit > 0) {
    const out: SessionMsg[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const msgs = normalizeLineMessages(lines[i]);
      for (let j = msgs.length - 1; j >= 0 && out.length < limit; j--) {
        out.push(msgs[j]);
      }
    }
    return out.reverse();
  }
  const msgs: SessionMsg[] = [];
  for (const l of lines) {
    msgs.push(...normalizeLineMessages(l));
  }
  return msgs;
}

type RecentMessagesCacheEntry = {
  mtimeMs: number;
  size: number;
  at: number;
  messages: SessionMsg[];
};
const recentMessagesCache = new Map<string, RecentMessagesCacheEntry>();
const RECENT_MESSAGES_CACHE_MAX = 160;

function recentMessagesCacheKey(path: string, limit: number, maxBytes: number | null): string {
  return `${path}\0${limit}\0${maxBytes ?? "all"}`;
}

function rememberRecentMessages(key: string, entry: RecentMessagesCacheEntry) {
  recentMessagesCache.set(key, entry);
  if (recentMessagesCache.size <= RECENT_MESSAGES_CACHE_MAX) return;
  const oldest = [...recentMessagesCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
  if (oldest) recentMessagesCache.delete(oldest);
}

export async function recentMessagesCached(
  path: string,
  limit = 40,
  opts: { maxBytes?: number | null } = {},
): Promise<SessionMsg[]> {
  const st = statSync(path);
  const maxBytes = opts.maxBytes === undefined ? 256 * 1024 : opts.maxBytes;
  const key = recentMessagesCacheKey(path, limit, maxBytes);
  const cached = recentMessagesCache.get(key);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    cached.at = Date.now();
    return cached.messages;
  }
  const messages = await recentMessages(path, limit, opts);
  rememberRecentMessages(key, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    at: Date.now(),
    messages,
  });
  return messages;
}

export function warmRecentMessages(paths: string[], limit = 40): void {
  for (const path of paths.slice(0, RECENT_MESSAGES_CACHE_MAX)) {
    void recentMessagesCached(path, limit).catch(() => {});
  }
}

// One transcript line that matched a search query: a clipped snippet centred on
// the hit, plus enough provenance (role/kind/ts/index) for the caller to locate
// it. `index` is the message's position in the scanned window (newest-last).
export type TranscriptMatch = {
  role: string;
  kind: SessionMsg["kind"];
  ts: number | null;
  snippet: string;
  index: number;
};

// Full-text search over a session's transcript. Reuses normalizeLineMessages so
// it works for every agent type (Claude + Codex JSONL), then does a case-
// insensitive substring scan over the normalized prose of each message —
// including thinking/tool blocks, since the agent often wants to find what a
// session was reasoning about, not just what it said out loud. Scans the tail
// (maxBytes, default 4 MB) newest-first so the most recent hits survive the
// result cap; the returned slice is re-sorted oldest→newest for readability.
export async function searchTranscript(
  path: string,
  query: string,
  opts: { limit?: number; maxBytes?: number | null; window?: number } = {},
): Promise<{ total: number; scanned: number; truncated: boolean; results: TranscriptMatch[] }> {
  const q = query.trim().toLowerCase();
  if (!q) return { total: 0, scanned: 0, truncated: false, results: [] };
  const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 50) : 12;
  const maxBytes = opts.maxBytes === undefined ? 4 * 1024 * 1024 : opts.maxBytes;
  const win = opts.window && opts.window > 0 ? opts.window : 200;

  const file = Bun.file(path);
  const size = file.size;
  const start = maxBytes == null ? 0 : Math.max(0, size - maxBytes);
  const truncated = start > 0;
  const text = await file.slice(start).text();
  const lines = text.split("\n").filter(Boolean);
  const msgs: SessionMsg[] = [];
  for (const l of lines) msgs.push(...normalizeLineMessages(l));

  const results: TranscriptMatch[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m.text) continue;
    const pos = m.text.toLowerCase().indexOf(q);
    if (pos < 0) continue;
    total++;
    if (results.length >= limit) continue;
    const half = Math.floor(win / 2);
    const from = Math.max(0, pos - half);
    const to = Math.min(m.text.length, pos + q.length + half);
    let snippet = m.text.slice(from, to).replace(/\s+/g, " ").trim();
    if (from > 0) snippet = `…${snippet}`;
    if (to < m.text.length) snippet = `${snippet}…`;
    results.push({ role: m.role, kind: m.kind, ts: m.ts, snippet, index: i });
  }
  results.reverse(); // chronological within the (newest-first capped) set
  return { total, scanned: msgs.length, truncated, results };
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
  const limit = Math.max(1, Math.min(500, opts.limit ?? 220));
  const file = Bun.file(path);
  const size = file.size;
  const end = Math.max(0, Math.min(size, opts.before ?? size));
  if (end <= 0) return { messages: [], nextBefore: null, total: 0 };

  // `before` is a byte cursor, not a message index. Read backwards in bounded
  // windows and include whole JSONL records, so opening a large transcript only
  // parses the tail page instead of the entire file.
  let windowBytes = 256 * 1024;
  const decoder = new TextDecoder();

  while (true) {
    const start = Math.max(0, end - windowBytes);
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    let firstComplete = 0;
    if (start > 0) {
      firstComplete = bytes.indexOf(10) + 1;
      if (firstComplete <= 0) {
        if (start === 0) firstComplete = 0;
        else {
          windowBytes = Math.min(size, windowBytes * 2);
          continue;
        }
      }
    }

    const lines: Array<{ offset: number; messages: SessionMsg[] }> = [];
    for (let lineStart = firstComplete; lineStart < bytes.length; ) {
      let lineEnd = lineStart;
      while (lineEnd < bytes.length && bytes[lineEnd] !== 10) lineEnd++;
      if (lineEnd > lineStart) {
        const text = decoder.decode(bytes.subarray(lineStart, lineEnd));
        const messages = normalizeLineMessages(text);
        if (messages.length) lines.push({ offset: start + lineStart, messages });
      }
      lineStart = lineEnd + 1;
    }

    let count = 0;
    let firstLine = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      count += lines[i].messages.length;
      firstLine = i;
      if (count >= limit) break;
    }

    if (count < limit && start > 0) {
      windowBytes = Math.min(size, windowBytes * 2);
      continue;
    }

    const selected = firstLine < lines.length ? lines.slice(firstLine) : [];
    const messages = selected.flatMap((line) => line.messages);
    const nextBefore = selected.length && selected[0].offset > 0 ? selected[0].offset : null;
    return {
      messages,
      nextBefore,
      // Kept for wire compatibility. The old exact total required a full
      // transcript parse; clients use `nextBefore` to decide whether more pages
      // exist.
      total: nextBefore == null ? messages.length : -1,
    };
  }
}
