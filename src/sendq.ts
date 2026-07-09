// Confirmed-delivery outbound message queue, one per Claude Code session.
//
// Driving an interactive TUI over tmux send-keys is racy: a fixed sleep before
// Enter loses messages when the TUI is busy, two quick sends interleave in the
// same input box, and a dropped Enter silently strands text in the composer
// while the caller is told "ok". This module turns send-and-pray into
// send-confirm-retry: it serializes one delivery at a time per session, types
// then waits until our text actually appears in the composer, presses Enter,
// then waits until the text *leaves* the box (the rendering-agnostic signal
// that Claude accepted it). It retries a stranded Enter, clears+retypes a
// dropped type, and only marks a message failed when it truly never landed.

import { randomBytes } from "node:crypto";
import {
  capturePane,
  parsePrompt,
  questionSelectorOpen,
  inputBoxText,
  tmuxType,
  tmuxEnter,
  tmuxClearInput,
  tmuxInterrupt,
  feedbackPromptOpen,
  tmuxDismissFeedback,
} from "./tmux.ts";
import { listSessions, resolveTranscript } from "./sessions.ts";
import { enqueueTranscriptIndex, indexedRecentMessages } from "./transcript-index.ts";
import { traceLog } from "./trace-log.ts";

export type QueuedMsg = {
  id: string;
  text: string;
  // pending: waiting behind earlier sends. sending: actively being typed +
  // confirmed. delivered: accepted by Claude (left the input box). queued:
  // accepted while Claude was mid-turn — it's in Claude's own queue, not yet in
  // the transcript. failed: never left the box after retries.
  status: "pending" | "sending" | "delivered" | "queued" | "failed";
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
};

type SessionQueue = { msgs: QueuedMsg[]; running: boolean };

const queues = new Map<string, SessionQueue>();

// Keep the per-session list from growing unbounded; terminal rows older than
// this many are pruned on each enqueue.
const KEEP_TERMINAL = 12;

function q(sessionId: string): SessionQueue {
  let s = queues.get(sessionId);
  if (!s) {
    s = { msgs: [], running: false };
    queues.set(sessionId, s);
  }
  return s;
}

export function listQueue(sessionId: string): QueuedMsg[] {
  return queues.get(sessionId)?.msgs ?? [];
}

export function getMessage(sessionId: string, id: string): QueuedMsg | null {
  return queues.get(sessionId)?.msgs.find((m) => m.id === id) ?? null;
}

export function enqueueMessage(sessionId: string, text: string): QueuedMsg {
  const s = q(sessionId);
  const now = Date.now();
  const msg: QueuedMsg = {
    id: randomBytes(8).toString("hex"),
    text,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  s.msgs.push(msg);
  traceLog("sendq_enqueue", { sessionId, messageId: msg.id, chars: text.length });
  pruneTerminal(s);
  kick(sessionId);
  return msg;
}

export function retryMessage(sessionId: string, id: string): QueuedMsg | null {
  const s = queues.get(sessionId);
  const msg = s?.msgs.find((m) => m.id === id);
  if (!s || !msg) return null;
  if (msg.status !== "failed") return msg;
  msg.status = "pending";
  msg.error = undefined;
  msg.attempts = 0;
  msg.updatedAt = Date.now();
  kick(sessionId);
  return msg;
}

// Drop messages the user no longer needs to see — everything that's reached a
// terminal state (delivered/queued/failed). In-flight messages (pending/
// sending) stay so a clear never silently abandons a send mid-delivery.
export function clearResolved(sessionId: string): number {
  const s = queues.get(sessionId);
  if (!s) return 0;
  const before = s.msgs.length;
  s.msgs = s.msgs.filter((m) => m.status === "pending" || m.status === "sending");
  return before - s.msgs.length;
}

function pruneTerminal(s: SessionQueue) {
  const terminal = s.msgs.filter(
    (m) => m.status === "delivered" || m.status === "queued" || m.status === "failed",
  );
  if (terminal.length <= KEEP_TERMINAL) return;
  const drop = new Set(
    terminal
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, terminal.length - KEEP_TERMINAL),
  );
  s.msgs = s.msgs.filter((m) => !drop.has(m));
}

function kick(sessionId: string) {
  const s = q(sessionId);
  if (s.running) return;
  s.running = true;
  (async () => {
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = s.msgs.find((m) => m.status === "pending");
        if (!next) break;
        next.status = "sending";
        next.updatedAt = Date.now();
        try {
          await deliver(sessionId, next);
        } catch (e) {
          next.status = "failed";
          next.error = e instanceof Error ? e.message : String(e);
        }
        next.updatedAt = Date.now();
      }
    } finally {
      s.running = false;
    }
  })();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// We match a normalized prefix rather than the whole message: the composer
// wraps long input across lines, so a full-string compare against the capture
// would never match.
const NEEDLE_LEN = 48;

// Does the composer currently show our message? Two probes, in order:
//
// 1. Needle: our normalized prefix is visible in the box. Definitive for short
//    drafts and unscrolled viewports.
// 2. Inverted (the codex long-draft case): the codex composer viewport scrolls
//    for long drafts, so NEITHER the head nor the tail of the draft is
//    guaranteed on screen — the needle probe false-negatives, and the queue
//    would clear + retype a message that was sitting there fine, then fail.
//    What IS guaranteed is that every visible composer line is a contiguous
//    slice of our draft, so check that direction: a non-empty box matches when
//    every visible line is a substring of the normalized message. A foreign
//    draft or placeholder ("Add a follow-up") fails this; a scrolled viewport
//    of ours passes. Checked per-line rather than joined, because a mid-word
//    wrap has no space at the seam — joining visible lines with a space would
//    fabricate one and break the substring match.
//
// Exported for tests: pure logic over a captured box string.
export function boxTextMatches(box: string, fullNorm: string, needle: string): boolean {
  const normBox = norm(box);
  if (!normBox) return false;
  if (normBox.includes(needle)) return true;
  const lines = box
    .split("\n")
    .map(norm)
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => fullNorm.includes(l));
}

function boxShowsMessage(target: string, fullNorm: string, needle: string): boolean | null {
  const box = inputBoxText(target);
  if (box == null) return null; // composer not visible (modal up, or unknown)
  return boxTextMatches(box, fullNorm, needle);
}

async function transcriptUserMatchCount(
  sessionId: string,
  transcriptPath: string | null,
  needle: string,
): Promise<number> {
  if (!transcriptPath) return 0;
  try {
    enqueueTranscriptIndex(transcriptPath, sessionId);
    const msgs = await indexedRecentMessages(transcriptPath, sessionId, 120);
    return msgs.filter(
      (m) => m.role === "user" && m.kind === "text" && norm(m.text).includes(needle),
    ).length;
  } catch {
    return 0;
  }
}

// A "queued" message left the input box while Claude was busy, so it sat in
// Claude's own queue rather than the transcript — deliver() can't wait for it
// to surface without blocking the per-session queue behind a turn that may run
// for minutes. So we reconcile lazily: whenever the UI polls, promote any
// queued message that has since shown up in the transcript to "delivered" (the
// UI then drops it). Returns true if anything changed so the caller re-emits.
export async function reconcileQueued(sessionId: string): Promise<boolean> {
  const s = queues.get(sessionId);
  if (!s) return false;
  const pending = s.msgs.filter((m) => m.status === "queued");
  if (!pending.length) return false;
  const transcriptPath = await resolveTranscript(sessionId);
  if (!transcriptPath) return false;
  let recent;
  try {
    enqueueTranscriptIndex(transcriptPath, sessionId);
    recent = await indexedRecentMessages(transcriptPath, sessionId, 40);
  } catch {
    return false;
  }
  let changed = false;
  for (const m of pending) {
    const needle = norm(m.text).slice(0, NEEDLE_LEN);
    const found = recent.some(
      (r) => r.role === "user" && r.kind === "text" && norm(r.text).includes(needle),
    );
    if (found) {
      m.status = "delivered";
      m.updatedAt = Date.now();
      traceLog("sendq_reconciled", { sessionId, messageId: m.id });
      changed = true;
    }
  }
  return changed;
}

// If the session-rating overlay is up it swallows Enter, so clear it before we
// type/submit. Returns true if it dismissed one (caller can give the TUI a beat
// to settle).
function clearFeedbackPrompt(target: string): boolean {
  const pane = capturePane(target);
  if (pane && feedbackPromptOpen(pane)) {
    tmuxDismissFeedback(target);
    return true;
  }
  return false;
}

async function deliver(sessionId: string, msg: QueuedMsg): Promise<void> {
  const started = performance.now();
  const sess = (await listSessions()).find((s) => s.sessionId === sessionId);
  const target = sess?.tmuxTarget ?? null;
  if (!target) {
    msg.status = "failed";
    msg.error = "session is not in a tmux pane";
    traceLog("sendq_failed", { sessionId, messageId: msg.id, error: msg.error });
    return;
  }
  const transcriptPath = await resolveTranscript(sessionId);
  const fullNorm = norm(msg.text);
  const needle = fullNorm.slice(0, NEEDLE_LEN);
  const transcriptMatchesBefore = await transcriptUserMatchCount(sessionId, transcriptPath, needle);
  traceLog("sendq_deliver_start", {
    sessionId,
    messageId: msg.id,
    transcriptPath,
    target,
    chars: msg.text.length,
  });

  // Clear any session-rating overlay first — it swallows Enter and would
  // otherwise strand every send with "never left the input box".
  if (clearFeedbackPrompt(target)) await sleep(300);

  // "Chat about this": when a selector (permission / plan / question dialog) is
  // open, sending a message means the user chose to type a reply instead of
  // clicking an option. Dismiss the selector (Escape) so the composer is
  // reachable, then fall through to the normal type+submit path. We used to
  // refuse and fail the send ("answer it first"), which dead-ended every
  // chat-instead-of-answer. Up to two Escapes (the first can be dropped by a
  // busy TUI); each is gated on the selector still being open, so we never Esc
  // an idle composer (which would trip the rewind-history overlay).
  //
  // We detect "selector open" two ways: parsePrompt catches permission/plan
  // dialogs (whose active option carries a `❯` cursor), and questionSelectorOpen
  // catches AskUserQuestion dialogs whose active option is highlighted via
  // reverse-video — capture-pane strips the highlight, so NO option line reads
  // as selected and parsePrompt returns null. Gating dismissal on parsePrompt
  // alone skipped the Escape for those question dialogs, fell through to typing
  // into a composer that isn't reachable, and stranded the send with "message
  // never left the input box after retries". The footer-based detector fixes it.
  const selectorOpen = (p: string) => !!parsePrompt(p) || questionSelectorOpen(p);
  for (let attempt = 0; attempt < 2; attempt++) {
    const pane = capturePane(target);
    if (!pane || !selectorOpen(pane)) break;
    tmuxInterrupt(target); // single Escape — cancels the open selector
    let cleared = false;
    for (let i = 0; i < 14; i++) {
      await sleep(150);
      const p = capturePane(target);
      if (!p || !selectorOpen(p)) {
        cleared = true;
        break;
      }
    }
    if (cleared) break;
    if (attempt === 1) {
      msg.status = "failed";
      msg.error = "a prompt/selector wouldn't dismiss — answer it first";
      traceLog("sendq_failed", { sessionId, messageId: msg.id, error: msg.error });
      return;
    }
  }

  const MAX_ATTEMPTS = 3;
  while (msg.attempts < MAX_ATTEMPTS) {
    msg.attempts++;
    msg.updatedAt = Date.now();
    traceLog("sendq_attempt", { sessionId, messageId: msg.id, attempt: msg.attempts });

    // Only type when our text isn't already sitting in the box (a previous
    // attempt may have typed it but failed to submit — retyping would double it).
    if (boxShowsMessage(target, fullNorm, needle) !== true) {
      // Wipe any foreign draft first. The composer may already hold text the
      // user (or a stranded earlier send) left there; tmuxType appends, so
      // without this our message fuses onto it and the merged line submits as
      // one garbled message. Ctrl-U on an empty box is a harmless no-op.
      tmuxClearInput(target);
      await sleep(120);
      tmuxType(target, msg.text);
      let settled = false;
      for (let i = 0; i < 20; i++) {
        await sleep(150);
        if (boxShowsMessage(target, fullNorm, needle) === true) {
          settled = true;
          break;
        }
      }
      if (!settled) {
        // Typing didn't register (cold TUI, lost keys). Clear any partial and
        // loop to retry from scratch.
        tmuxClearInput(target);
        await sleep(200);
        traceLog("sendq_type_retry", { sessionId, messageId: msg.id, attempt: msg.attempts });
        continue;
      }
    }

    // The rating overlay can surface between turns, right as we're about to
    // submit; clear it again so this Enter isn't swallowed.
    if (clearFeedbackPrompt(target)) await sleep(300);

    // Submit, then confirm acceptance. Claude clears the composer when it
    // accepts a message. Codex keeps the submitted `› ...` prompt visible while
    // it works, so transcript growth is also an accept signal.
    tmuxEnter(target);
    for (let i = 0; i < 24; i++) {
      await sleep(150);
      const inBox = boxShowsMessage(target, fullNorm, needle);
      const transcriptMatchesNow = await transcriptUserMatchCount(sessionId, transcriptPath, needle);
      if (transcriptMatchesNow > transcriptMatchesBefore) {
        msg.status = "delivered";
        msg.error = undefined;
        traceLog("sendq_delivered", {
          sessionId,
          messageId: msg.id,
          via: "transcript_index",
          attempts: msg.attempts,
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        });
        return;
      }
      // inBox === false: the composer is visible and our text is gone.
      // inBox === null: the composer vanished entirely — a selector/overlay
      //   opened right after our Enter (the message triggered a permission
      //   prompt, or the rating overlay surfaced). Either way the text is no
      //   longer sitting pending in the box, so the submit landed. Only
      //   inBox === true (text still there) means the Enter didn't take.
      if (inBox === false || inBox === null) {
        // Accepted. A slash command (/clear, /compact, …) executes immediately
        // and never surfaces as a user-text turn — /clear even wipes the
        // transcript — so the transcript probe would never confirm it and it
        // would hang at "queued" forever. Treat it as delivered the moment it
        // leaves the box. Otherwise it may be queued behind the current turn
        // (reconcileQueued promotes it once it surfaces).
        const isCommand = msg.text.trimStart().startsWith("/");
        msg.status = isCommand
          ? "delivered"
          : "queued";
        msg.error = undefined;
        traceLog("sendq_accepted", {
          sessionId,
          messageId: msg.id,
          status: msg.status,
          attempts: msg.attempts,
          durationMs: Math.round((performance.now() - started) * 1000) / 1000,
        });
        return;
      }
    }
    // Still in the box → the Enter didn't submit. Loop: we'll skip retyping
    // (needle present) and press Enter again.
  }

  msg.status = "failed";
  msg.error = "message never left the input box after retries";
  traceLog("sendq_failed", {
    sessionId,
    messageId: msg.id,
    error: msg.error,
    attempts: msg.attempts,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
}
