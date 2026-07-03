import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../config.ts";

export type SessionBrainDecisionAction =
  | "keep_live"
  | "needs_input"
  | "archive_and_close"
  | "close_no_note";

export type SessionNoteStatus = "open" | "snoozed" | "done" | "dismissed";
export type PatternSuggestionStatus = "open" | "accepted" | "dismissed";

export type SessionNote = {
  id: string;
  sourceSessionId: string;
  sourceNativeSessionId?: string | null;
  agent: string;
  title: string;
  cwd: string | null;
  project: string;
  summary: string;
  nextActions: string[];
  blockers: string[];
  resumePrompt: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  status: SessionNoteStatus;
};

export type SessionBrainDecision = {
  sessionId: string;
  title: string;
  action: SessionBrainDecisionAction;
  reason: string;
  confidence: number;
  noteId?: string;
  closed?: boolean;
  guardrail?: string;
  // Set when the model classifier could not run and we silently fell back to the
  // rule-based heuristic (e.g. expired OAuth token, API error). Surfaced into the
  // run's errors[] so a degraded brain doesn't masquerade as a clean run.
  classifierError?: string;
  // Set when the merge-guard intervened on an otherwise-closeable session.
  mergeFollowUp?: {
    branch: string;
    aheadCommits: number;
    dirtyFiles: number;
    attempts: number;
    outcome: "asked" | "deferred" | "escalated";
  };
};

export type PatternSuggestion = {
  id: string;
  key: string;
  title: string;
  reasoning: string;
  recommendation: string;
  evidence: string[];
  createdAt: number;
  updatedAt: number;
  status: PatternSuggestionStatus;
};

export type SessionBrainRun = {
  id: string;
  startedAt: number;
  finishedAt?: number;
  autoClose: boolean;
  scanned: number;
  decisions: SessionBrainDecision[];
  suggestions: string[];
  errors: string[];
};

export type SessionBrainConfig = {
  enabled: boolean;
  autoClose: boolean;
  intervalMin: number;
  minIdleMin: number;
  // When true, the brain refuses to archive a session whose worktree branch has
  // unmerged commits/changes and instead asks the agent to resolve them first.
  mergeGuard: boolean;
  // Anthropic model the brain's classifier/summarizer runs on. Seeded from
  // LFG_SESSION_BRAIN_MODEL / LFG_SESSION_SUMMARY_MODEL at first write; once
  // persisted here, this value wins over the env vars.
  model: string;
};

// Per-session record tracking outstanding "please merge before I archive"
// follow-ups the brain has sent, so it backs off (cooldown) and eventually
// gives up gating (maxFollowUps) rather than leaking a session forever.
export type MergeFollowUp = {
  sessionId: string;
  branch: string;
  repoRoot: string;
  wtPath: string;
  aheadCommits: number;
  dirtyFiles: number;
  attempts: number;
  firstAskedAt: number;
  lastAskedAt: number;
};

const dir = () => join(PATHS.data, "session-brain");
const configPath = () => join(dir(), "config.json");
const notesPath = () => join(dir(), "notes.json");
const suggestionsPath = () => join(dir(), "suggestions.json");
const runsPath = () => join(dir(), "runs.jsonl");
const mergeFollowUpsPath = () => join(dir(), "merge-followups.json");

async function ensure() {
  await mkdir(dir(), { recursive: true });
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  try {
    const parsed = JSON.parse(await f.text());
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(path: string, rows: T[]): Promise<void> {
  await ensure();
  await Bun.write(path, JSON.stringify(rows, null, 2));
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || "");
  const n = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.max(min, Math.min(max, n));
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function defaultSessionBrainConfig(): SessionBrainConfig {
  return {
    enabled: boolEnv("LFG_SESSION_BRAIN_ENABLED", false),
    autoClose: boolEnv("LFG_SESSION_BRAIN_AUTOCLOSE", false),
    intervalMin: numberEnv("LFG_SESSION_BRAIN_INTERVAL_MIN", 60, 5, 24 * 60),
    minIdleMin: numberEnv("LFG_SESSION_BRAIN_MIN_IDLE_MIN", 45, 0, 24 * 60),
    mergeGuard: boolEnv("LFG_SESSION_BRAIN_MERGE_GUARD", true),
    model: process.env.LFG_SESSION_BRAIN_MODEL || process.env.LFG_SESSION_SUMMARY_MODEL || "claude-sonnet-5",
  };
}

function normalizeConfig(input: Partial<SessionBrainConfig> | null | undefined): SessionBrainConfig {
  const defaults = defaultSessionBrainConfig();
  return {
    enabled: typeof input?.enabled === "boolean" ? input.enabled : defaults.enabled,
    autoClose: typeof input?.autoClose === "boolean" ? input.autoClose : defaults.autoClose,
    intervalMin: Math.max(
      5,
      Math.min(24 * 60, Number.isFinite(input?.intervalMin) ? Number(input?.intervalMin) : defaults.intervalMin),
    ),
    minIdleMin: Math.max(
      0,
      Math.min(24 * 60, Number.isFinite(input?.minIdleMin) ? Number(input?.minIdleMin) : defaults.minIdleMin),
    ),
    mergeGuard: typeof input?.mergeGuard === "boolean" ? input.mergeGuard : defaults.mergeGuard,
    model: typeof input?.model === "string" && input.model.trim() ? input.model.trim() : defaults.model,
  };
}

export async function readSessionBrainConfig(): Promise<SessionBrainConfig> {
  const f = Bun.file(configPath());
  if (!(await f.exists())) return defaultSessionBrainConfig();
  try {
    return normalizeConfig(JSON.parse(await f.text()) as Partial<SessionBrainConfig>);
  } catch {
    return defaultSessionBrainConfig();
  }
}

export async function updateSessionBrainConfig(
  patch: Partial<SessionBrainConfig>,
): Promise<SessionBrainConfig> {
  const current = await readSessionBrainConfig();
  const next = normalizeConfig({ ...current, ...patch });
  await ensure();
  await Bun.write(configPath(), JSON.stringify(next, null, 2));
  return next;
}

export async function listSessionNotes(status?: string): Promise<SessionNote[]> {
  const rows = await readJsonArray<SessionNote>(notesPath());
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return status ? rows.filter((r) => r.status === status) : rows;
}

export async function upsertSessionNote(input: {
  sourceSessionId: string;
  sourceNativeSessionId?: string | null;
  agent: string;
  title: string;
  cwd: string | null;
  project: string;
  summary: string;
  nextActions: string[];
  blockers: string[];
  resumePrompt: string;
  closedAt?: number;
}): Promise<SessionNote> {
  const now = Date.now();
  const rows = await listSessionNotes();
  const existing = rows.find((r) => r.sourceSessionId === input.sourceSessionId);
  const note: SessionNote = {
    id: existing?.id ?? randomBytes(6).toString("hex"),
    sourceSessionId: input.sourceSessionId,
    sourceNativeSessionId: input.sourceNativeSessionId ?? existing?.sourceNativeSessionId ?? null,
    agent: input.agent,
    title: input.title.slice(0, 160),
    cwd: input.cwd,
    project: input.project,
    summary: input.summary.slice(0, 2_000),
    nextActions: input.nextActions.map((s) => s.trim()).filter(Boolean).slice(0, 8),
    blockers: input.blockers.map((s) => s.trim()).filter(Boolean).slice(0, 8),
    resumePrompt: input.resumePrompt.slice(0, 4_000),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    closedAt: input.closedAt ?? existing?.closedAt,
    status: existing?.status ?? "open",
  };
  const next = existing
    ? rows.map((r) => (r.id === existing.id ? note : r))
    : [note, ...rows];
  await writeJsonArray(notesPath(), next);
  return note;
}

export async function updateSessionNoteStatus(
  id: string,
  status: SessionNoteStatus,
): Promise<SessionNote | null> {
  const rows = await listSessionNotes();
  let found: SessionNote | null = null;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    found = { ...r, status, updatedAt: Date.now() };
    return found;
  });
  if (!found) return null;
  await writeJsonArray(notesPath(), next);
  return found;
}

export async function listPatternSuggestions(status?: string): Promise<PatternSuggestion[]> {
  const rows = await readJsonArray<PatternSuggestion>(suggestionsPath());
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return status ? rows.filter((r) => r.status === status) : rows;
}

export async function upsertPatternSuggestion(input: {
  key: string;
  title: string;
  reasoning: string;
  recommendation: string;
  evidence: string[];
}): Promise<PatternSuggestion> {
  const now = Date.now();
  const rows = await listPatternSuggestions();
  const existing = rows.find((r) => r.key === input.key);
  const suggestion: PatternSuggestion = {
    id: existing?.id ?? randomBytes(6).toString("hex"),
    key: input.key.slice(0, 120),
    title: input.title.slice(0, 160),
    reasoning: input.reasoning.slice(0, 1_500),
    recommendation: input.recommendation.slice(0, 2_500),
    evidence: input.evidence.map((s) => s.trim()).filter(Boolean).slice(0, 8),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    status: existing?.status ?? "open",
  };
  const next = existing
    ? rows.map((r) => (r.id === existing.id ? suggestion : r))
    : [suggestion, ...rows];
  await writeJsonArray(suggestionsPath(), next);
  return suggestion;
}

export async function updatePatternSuggestionStatus(
  id: string,
  status: PatternSuggestionStatus,
): Promise<PatternSuggestion | null> {
  const rows = await listPatternSuggestions();
  let found: PatternSuggestion | null = null;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    found = { ...r, status, updatedAt: Date.now() };
    return found;
  });
  if (!found) return null;
  await writeJsonArray(suggestionsPath(), next);
  return found;
}

export async function appendSessionBrainRun(run: SessionBrainRun): Promise<void> {
  await ensure();
  await appendFile(runsPath(), JSON.stringify(run) + "\n");
}

export async function listMergeFollowUps(): Promise<MergeFollowUp[]> {
  return readJsonArray<MergeFollowUp>(mergeFollowUpsPath());
}

export async function getMergeFollowUp(sessionId: string): Promise<MergeFollowUp | null> {
  const rows = await listMergeFollowUps();
  return rows.find((r) => r.sessionId === sessionId) ?? null;
}

// Record (or bump) a follow-up for a session. Increments the attempt counter
// and refreshes the observed branch state + timestamps.
export async function recordMergeFollowUp(input: {
  sessionId: string;
  branch: string;
  repoRoot: string;
  wtPath: string;
  aheadCommits: number;
  dirtyFiles: number;
}): Promise<MergeFollowUp> {
  const now = Date.now();
  const rows = await listMergeFollowUps();
  const existing = rows.find((r) => r.sessionId === input.sessionId);
  const row: MergeFollowUp = {
    sessionId: input.sessionId,
    branch: input.branch,
    repoRoot: input.repoRoot,
    wtPath: input.wtPath,
    aheadCommits: input.aheadCommits,
    dirtyFiles: input.dirtyFiles,
    attempts: (existing?.attempts ?? 0) + 1,
    firstAskedAt: existing?.firstAskedAt ?? now,
    lastAskedAt: now,
  };
  const next = existing
    ? rows.map((r) => (r.sessionId === input.sessionId ? row : r))
    : [row, ...rows];
  await writeJsonArray(mergeFollowUpsPath(), next);
  return row;
}

export async function clearMergeFollowUp(sessionId: string): Promise<void> {
  const rows = await listMergeFollowUps();
  const next = rows.filter((r) => r.sessionId !== sessionId);
  if (next.length !== rows.length) await writeJsonArray(mergeFollowUpsPath(), next);
}

export async function listSessionBrainRuns(limit = 20): Promise<SessionBrainRun[]> {
  const f = Bun.file(runsPath());
  if (!(await f.exists())) return [];
  const rows = (await f.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as SessionBrainRun;
      } catch {
        return null;
      }
    })
    .filter((r): r is SessionBrainRun => !!r);
  return rows.slice(-Math.max(1, Math.min(100, limit))).reverse();
}
