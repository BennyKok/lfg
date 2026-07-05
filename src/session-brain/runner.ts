import { randomBytes } from "node:crypto";
import {
  listSessions,
  pendingToolPrompt,
  recentMessages,
  type Session,
} from "../sessions.ts";
import {
  appendCmd as appendAisdkCmd,
  findEntryByAnyId as findAisdkEntryByAnyId,
  removeEntry as removeAisdkEntry,
} from "../aisdk-registry.ts";
import { markClosed } from "../closing.ts";
import { removeManaged } from "../managed.ts";
import { assignUser } from "../users.ts";
import { tmuxKillPane, tmuxKillSession } from "../tmux.ts";
import { classifySession, featuresForSession, suggestPromptImprovements, type SessionFeatures } from "./classifier.ts";
import {
  appendSessionBrainRun,
  clearMergeFollowUp,
  getMergeFollowUp,
  listSessionNotes,
  readSessionBrainConfig,
  recordMergeFollowUp,
  type SessionBrainConfig,
  type SessionBrainDecision,
  type SessionBrainRun,
  upsertPatternSuggestion,
  upsertSessionNote,
} from "./store.ts";
import {
  agentSignaledDisposable,
  describeBranchState,
  hasUnmergedWork,
  inspectSessionBranch,
  mergeFollowUpPrompt,
  sendBrainPrompt,
} from "./merge-guard.ts";

let activeRun: Promise<SessionBrainRun> | null = null;
const RECENT_SESSION_CLOSE_GRACE_MS = 15 * 60_000;

function canClose(
  session: Session,
  action: string,
  confidence: number,
  minIdleMin: number,
  opts: { bypassIdleGuard?: boolean } = {},
): string | null {
  if (!session.sessionId) return "session has no id";
  if (session.busy) return "session is busy";
  if (session.launching) return "session is still launching";
  if (session.status === "blocked") return "session is blocked and needs input";
  if (session.startedAt && Date.now() - session.startedAt < RECENT_SESSION_CLOSE_GRACE_MS)
    return "session was started or resumed recently";
  if (action !== "archive_and_close" && action !== "close_no_note") return "decision is not a close action";
  if (confidence < 0.72) return "decision confidence is below close threshold";
  if (!opts.bypassIdleGuard && session.lastActivityAt && Date.now() - session.lastActivityAt < minIdleMin * 60_000) {
    return `session is newer than ${minIdleMin} idle minutes`;
  }
  return null;
}

function closeSession(session: Session): boolean {
  if (!session.sessionId) return false;
  if (session.agent === "aisdk" || session.agent === "codex-aisdk" || session.agent === "opencode") {
    const key = findAisdkEntryByAnyId(session.sessionId)?.sessionId ?? session.sessionId;
    appendAisdkCmd(key, { type: "close" });
    if (session.tmuxName) tmuxKillSession(session.tmuxName);
    markClosed(session.pid);
    removeAisdkEntry(key);
    if (session.tmuxName) {
      removeManaged(session.tmuxName);
      assignUser(session.tmuxName, null);
    }
    return true;
  }
  if (!session.tmuxTarget) return false;
  const ok =
    session.managed && session.tmuxName
      ? tmuxKillSession(session.tmuxName)
      : tmuxKillPane(session.tmuxTarget);
  if (!ok) return false;
  markClosed(session.pid);
  if (session.managed && session.tmuxName) {
    removeManaged(session.tmuxName);
    assignUser(session.tmuxName, null);
  }
  return true;
}

function shouldConsider(session: Session, minIdleMin: number): boolean {
  if (!session.sessionId) return false;
  if (session.launching) return true;
  if (session.busy || session.status === "blocked") return true;
  if (!session.lastActivityAt) return true;
  return Date.now() - session.lastActivityAt >= minIdleMin * 60_000;
}

export async function runSessionBrain(
  opts: { autoClose?: boolean; limit?: number } = {},
  onLog: (line: string) => void = () => {},
): Promise<SessionBrainRun> {
  if (activeRun) {
    onLog("[session-brain] run already active; joining it");
    return activeRun;
  }
  activeRun = runSessionBrainInner(opts, onLog).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

export async function runSessionBrainForSession(
  sessionId: string,
  onLog: (line: string) => void = () => {},
): Promise<SessionBrainRun> {
  const config = await readSessionBrainConfig();
  const run: SessionBrainRun = {
    id: randomBytes(6).toString("hex"),
    startedAt: Date.now(),
    autoClose: true,
    scanned: 0,
    decisions: [],
    suggestions: [],
    errors: [],
  };
  try {
    const session = (await listSessions()).find((s) => s.sessionId === sessionId);
    if (!session) throw new Error("session not found");
    run.scanned = 1;
    const decision = await processSessionForBrain(
      session,
      { ...config, autoClose: true },
      onLog,
      { bypassIdleGuard: true, forceNoteForClose: true },
    );
    run.decisions.push(decision);
    if (decision.classifierError) {
      run.errors.push(`classifier fell back to heuristic: ${decision.classifierError}`);
    }
  } catch (e) {
    run.errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    run.finishedAt = Date.now();
    await appendSessionBrainRun(run);
  }
  return run;
}

async function runSessionBrainInner(
  opts: { autoClose?: boolean; limit?: number } = {},
  onLog: (line: string) => void = () => {},
): Promise<SessionBrainRun> {
  const config = await readSessionBrainConfig();
  const run: SessionBrainRun = {
    id: randomBytes(6).toString("hex"),
    startedAt: Date.now(),
    autoClose: opts.autoClose ?? config.autoClose,
    scanned: 0,
    decisions: [],
    suggestions: [],
    errors: [],
  };
  try {
    const all = await listSessions();
    const candidates = all
      .filter((session) => shouldConsider(session, config.minIdleMin))
      .slice(0, Math.max(1, Math.min(100, opts.limit ?? 40)));
    run.scanned = candidates.length;
    onLog(`[session-brain] scanning ${candidates.length}/${all.length} sessions`);

    for (const session of candidates) {
      if (!session.sessionId) continue;
      try {
        const decision = await processSessionForBrain(session, config, onLog);
        run.decisions.push(decision);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        run.errors.push(`${session.sessionId}: ${message}`);
        onLog(`[session-brain] ${session.sessionId} failed: ${message}`);
      }
    }

    // Surface silent model-classifier failures (e.g. expired OAuth token) so a
    // brain that has degraded to the rule-based heuristic doesn't look like a
    // clean run. Deduped: one auth failure hits every session, log it once.
    for (const msg of new Set(run.decisions.map((d) => d.classifierError).filter(Boolean) as string[])) {
      run.errors.push(`classifier fell back to heuristic: ${msg}`);
      onLog(`[session-brain] classifier degraded — ${msg}`);
    }

    const notes = (await listSessionNotes())
      .slice(0, 40)
      .map((n) => ({
        title: n.title,
        summary: n.summary,
        nextActions: n.nextActions,
        blockers: n.blockers,
      }));
    const suggestions = await suggestPromptImprovements({
      notes,
      decisions: run.decisions.map((d) => ({
        action: d.action,
        reason: d.reason,
        title: d.title,
      })),
    }, config.model);
    for (const s of suggestions) {
      const saved = await upsertPatternSuggestion(s);
      run.suggestions.push(saved.id);
    }
  } finally {
    run.finishedAt = Date.now();
    await appendSessionBrainRun(run);
  }
  return run;
}

async function processSessionForBrain(
  session: Session,
  config: SessionBrainConfig,
  onLog: (line: string) => void,
  opts: { bypassIdleGuard?: boolean; forceNoteForClose?: boolean } = {},
): Promise<SessionBrainDecision> {
  if (!session.sessionId) throw new Error("session has no id");
  const messages = session.transcriptPath
    ? await recentMessages(session.transcriptPath, 80, { maxBytes: 256 * 1024 })
    : [];
  const pending = session.transcriptPath
    ? !!(await pendingToolPrompt(session.transcriptPath).catch(() => null))
    : false;
  const features = featuresForSession(session, messages, pending);
  const { classification, generated, error: classifierError } = await classifySession(features, config.model);

  const isCloseAction =
    classification.action === "archive_and_close" || classification.action === "close_no_note";

  const guardrail = canClose(
    session,
    classification.action,
    classification.confidence,
    config.minIdleMin,
    { bypassIdleGuard: opts.bypassIdleGuard },
  );

  // Merge-guard: only when a close is otherwise imminent do we check the
  // worktree branch for unmerged work. If found, we defer the close and nudge
  // the agent to decide — we never merge for it.
  let mergeGuard: MergeGuardResult = { allowClose: true };
  if (config.mergeGuard && config.autoClose && !guardrail && isCloseAction) {
    mergeGuard = await evaluateMergeGuard(session, features, onLog);
  } else if (isCloseAction && session.sessionId) {
    await clearMergeFollowUp(session.sessionId).catch(() => {});
  }

  const recoverable = mergeGuard.recoverable;
  const blockers = recoverable
    ? [...classification.blockers, recoverableBlockerLine(recoverable)]
    : classification.blockers;

  // Always leave a durable note when we force-archive a session that still had
  // unmerged work, so the branch pointer is never lost.
  const shouldWriteNote =
    classification.action === "archive_and_close" ||
    !!recoverable ||
    (opts.forceNoteForClose && classification.action === "close_no_note");

  let noteId: string | undefined;
  if (shouldWriteNote) {
    const note = await upsertSessionNote({
      sourceSessionId: session.sessionId,
      sourceNativeSessionId: session.nativeSessionId,
      agent: session.agent,
      title: features.title,
      cwd: session.cwd,
      project: session.project,
      summary: classification.summary,
      nextActions: classification.nextActions,
      blockers,
      resumePrompt: classification.resumePrompt,
    });
    noteId = note.id;
  }

  let closed = false;
  if (config.autoClose && !guardrail && isCloseAction && mergeGuard.allowClose) {
    closed = closeSession(session);
    if (closed) {
      if (session.sessionId) await clearMergeFollowUp(session.sessionId).catch(() => {});
      if (shouldWriteNote) {
        await upsertSessionNote({
          sourceSessionId: session.sessionId,
          sourceNativeSessionId: session.nativeSessionId,
          agent: session.agent,
          title: features.title,
          cwd: session.cwd,
          project: session.project,
          summary: classification.summary,
          nextActions: classification.nextActions,
          blockers,
          resumePrompt: classification.resumePrompt,
          closedAt: Date.now(),
        });
      }
    }
  }

  const effectiveGuardrail = guardrail ?? mergeGuard.guardrail;

  const decision: SessionBrainDecision = {
    sessionId: session.sessionId,
    title: features.title,
    action: classification.action,
    reason: `${classification.reason}${generated ? "" : " (heuristic)"}`,
    confidence: classification.confidence,
    noteId,
    closed,
    guardrail: effectiveGuardrail ?? undefined,
    mergeFollowUp: mergeGuard.mergeFollowUp,
    classifierError: classifierError,
  };
  onLog(
    `[session-brain] ${decision.action} ${features.title} confidence=${decision.confidence.toFixed(2)}${decision.guardrail ? ` guard=${decision.guardrail}` : ""}`,
  );
  return decision;
}

type MergeGuardResult = {
  allowClose: boolean;
  guardrail?: string;
  mergeFollowUp?: SessionBrainDecision["mergeFollowUp"];
  recoverable?: { branch: string; repoRoot: string; aheadCommits: number; dirtyFiles: number };
};

function mergeMaxFollowUps(): number {
  const raw = Number(process.env.LFG_SESSION_BRAIN_MERGE_MAX_FOLLOWUPS || "");
  return Number.isFinite(raw) && raw >= 0 ? Math.min(10, raw) : 2;
}

function mergeCooldownMs(): number {
  const raw = Number(process.env.LFG_SESSION_BRAIN_MERGE_COOLDOWN_MIN || "");
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(24 * 60, raw) : 20;
  return min * 60_000;
}

function recoverableBlockerLine(r: {
  branch: string;
  repoRoot: string;
  aheadCommits: number;
  dirtyFiles: number;
}): string {
  const desc = [
    r.aheadCommits ? `${r.aheadCommits} unmerged commit${r.aheadCommits === 1 ? "" : "s"}` : "",
    r.dirtyFiles ? `${r.dirtyFiles} uncommitted change${r.dirtyFiles === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `Unmerged work preserved on branch \`${r.branch}\` (${desc}). Recover with: git -C ${r.repoRoot} worktree add /tmp/recover-${r.branch} ${r.branch}`;
}

// Decide the fate of a closeable session whose worktree branch may carry
// unmerged work. Never merges — asks the live agent to, and only lets the close
// proceed once the branch is clean, the agent declared it disposable, the agent
// is unreachable, or we've exhausted our follow-ups (branch is preserved either
// way, since worktree cleanup never deletes the branch).
async function evaluateMergeGuard(
  session: Session,
  features: SessionFeatures,
  onLog: (line: string) => void,
): Promise<MergeGuardResult> {
  const sessionId = session.sessionId;
  if (!sessionId) return { allowClose: true };

  const state = inspectSessionBranch(session);
  if (!hasUnmergedWork(state) || !state) {
    await clearMergeFollowUp(sessionId).catch(() => {});
    return { allowClose: true };
  }

  const recoverable = {
    branch: state.branch,
    repoRoot: state.repoRoot,
    aheadCommits: state.aheadCommits,
    dirtyFiles: state.dirtyFiles,
  };

  // Agent explicitly declared the branch disposable — honor it (branch is still
  // preserved for recovery).
  if (agentSignaledDisposable(features.lastAssistant) || agentSignaledDisposable(features.lastUser)) {
    onLog(`[session-brain] ${state.branch} marked disposable by agent — archiving (branch preserved)`);
    await clearMergeFollowUp(sessionId).catch(() => {});
    return { allowClose: true, recoverable };
  }

  const prior = await getMergeFollowUp(sessionId);
  const attempts = prior?.attempts ?? 0;

  // Exhausted our nudges — stop gating so we don't leak the session forever.
  if (attempts >= mergeMaxFollowUps()) {
    onLog(
      `[session-brain] ${state.branch} still unmerged after ${attempts} follow-up(s) — archiving; branch preserved for recovery`,
    );
    await clearMergeFollowUp(sessionId).catch(() => {});
    return {
      allowClose: true,
      recoverable,
      mergeFollowUp: {
        branch: state.branch,
        aheadCommits: state.aheadCommits,
        dirtyFiles: state.dirtyFiles,
        attempts,
        outcome: "escalated",
      },
    };
  }

  // Recently nudged — keep deferring without re-asking (agent is likely still
  // working through it).
  if (prior && Date.now() - prior.lastAskedAt < mergeCooldownMs()) {
    return {
      allowClose: false,
      guardrail: `unmerged work on ${state.branch} — awaiting agent (asked ${attempts}x)`,
      mergeFollowUp: {
        branch: state.branch,
        aheadCommits: state.aheadCommits,
        dirtyFiles: state.dirtyFiles,
        attempts,
        outcome: "deferred",
      },
    };
  }

  // Nudge the live agent to decide/merge. Queue mode so we never interrupt.
  const sent = sendBrainPrompt(session, mergeFollowUpPrompt(state), { mode: "queue" });
  if (!sent.ok) {
    // Can't reach the agent to ask — archive with a recoverable pointer rather
    // than deferring forever.
    onLog(
      `[session-brain] ${state.branch} has ${describeBranchState(state)} but agent is unreachable (${sent.error}) — archiving; branch preserved`,
    );
    await clearMergeFollowUp(sessionId).catch(() => {});
    return {
      allowClose: true,
      recoverable,
      mergeFollowUp: {
        branch: state.branch,
        aheadCommits: state.aheadCommits,
        dirtyFiles: state.dirtyFiles,
        attempts,
        outcome: "escalated",
      },
    };
  }

  const rec = await recordMergeFollowUp({
    sessionId,
    branch: state.branch,
    repoRoot: state.repoRoot,
    wtPath: state.wtPath,
    aheadCommits: state.aheadCommits,
    dirtyFiles: state.dirtyFiles,
  });
  onLog(
    `[session-brain] ${state.branch} has ${describeBranchState(state)} — asked agent to merge/decide; deferring archive (attempt ${rec.attempts})`,
  );
  return {
    allowClose: false,
    guardrail: `unmerged work on ${state.branch} — asked agent to resolve`,
    mergeFollowUp: {
      branch: state.branch,
      aheadCommits: state.aheadCommits,
      dirtyFiles: state.dirtyFiles,
      attempts: rec.attempts,
      outcome: "asked",
    },
  };
}
