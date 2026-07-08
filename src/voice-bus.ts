// Fleet completion bus for the voice assistant.
//
// Before this, the voice brain (deploy/voice/agent.py) learned about other
// sessions only at connect (a one-shot snapshot baked into its system prompt)
// or by polling get_fleet_status itself mid-turn. Nothing told it when another
// session FINISHED. This module turns "a session just completed a turn" into a
// PUSH:
//
//   - a single background watcher samples each session's busy state on an
//     interval and detects busy -> idle transitions (= a session landed work),
//   - it fans those out as events to any subscriber,
//   - serve exposes them over SSE at /api/voice/events; the voice worker
//     subscribes, refreshes its live context, and can speak a proactive
//     heads-up the instant a session lands.
//
// The watcher is process-global and idempotent (one loop regardless of how many
// subscribers connect). Busy detection reuses the exact signals the live view
// already streams: a tmux pane via isBusy(), a pane-less aisdk/codex/opencode
// session via the registry's isEntryBusy().

import { listSessions, resolveTranscript, type Session } from "./sessions.ts";
import { capturePane, isBusy } from "./tmux.ts";
import { findEntryByAnyId, isEntryBusy } from "./aisdk-registry.ts";
import { enqueueTranscriptIndex } from "./transcript-index.ts";

export type FleetEvent = {
  type: "completed";
  sessionId: string;
  title: string;
  user: string | null;
  at: number;
};

type Subscriber = {
  // null / "__all" → the whole fleet; otherwise only this user's sessions.
  user: string | null;
  cb: (ev: FleetEvent) => void;
};

const subscribers = new Set<Subscriber>();

/**
 * Subscribe to fleet completion events, scoped to a single user (empty / null /
 * "__all" = every session). Returns an unsubscribe function.
 */
export function subscribeFleet(
  user: string | null,
  cb: (ev: FleetEvent) => void,
): () => void {
  const sub: Subscriber = { user: user && user !== "__all" ? user : null, cb };
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

function emit(ev: FleetEvent): void {
  for (const sub of subscribers) {
    // A user-scoped subscriber only hears about its own sessions; an unscoped
    // subscriber (operator view) hears everything.
    if (sub.user && ev.user !== sub.user) continue;
    try {
      sub.cb(ev);
    } catch {
      // a single bad subscriber must never wedge the fan-out
    }
  }
}

// Per-session liveness state. We only fire a "completed" event on a settled
// busy -> idle edge: a session that goes briefly idle between two tool calls
// must NOT read as "done", so we require idle to hold for SETTLE_TICKS samples
// after a busy episode before emitting, and we emit at most once per episode.
type Liveness = {
  busy: boolean;
  idleStreak: number; // consecutive idle samples since last busy
  pendingComplete: boolean; // was busy and is now settling toward "completed"
};

const state = new Map<string, Liveness>();

// How long an idle reading must persist before we call a turn "completed".
// At TICK_MS=1500 and SETTLE_TICKS=2 that's ~3s of continuous idle — long
// enough to ride over the gap between tool calls, short enough to feel live.
const TICK_MS = 1500;
const SETTLE_TICKS = 2;

function sessionBusy(s: Session): boolean {
  if (s.tmuxTarget) {
    const pane = capturePane(s.tmuxTarget);
    return pane ? isBusy(pane) : false;
  }
  if (s.sessionId) {
    const e = findEntryByAnyId(s.sessionId);
    return e ? isEntryBusy(e) : false;
  }
  return false;
}

async function tick(): Promise<void> {
  let sessions: Session[];
  try {
    sessions = await listSessions();
  } catch {
    return; // transient — try again next tick
  }

  const seen = new Set<string>();
  for (const s of sessions) {
    const id = s.sessionId;
    if (!id) continue;
    seen.add(id);
    const busy = sessionBusy(s);
    const prev = state.get(id);

    if (!prev) {
      // First time we've seen this session. Seed its state without emitting for
      // sessions that are already idle (a server restart must not fire a burst
      // of "completed"). A session that is already BUSY, though, is mid-episode
      // — seed it as pending so we DO announce when it lands (the common "it was
      // working when voice connected, now it's done" case).
      state.set(id, {
        busy,
        idleStreak: busy ? 0 : SETTLE_TICKS,
        pendingComplete: busy,
      });
      continue;
    }

    if (busy) {
      prev.busy = true;
      prev.idleStreak = 0;
      prev.pendingComplete = true; // an episode is in flight; idle will settle it
      continue;
    }

    // Currently idle.
    if (prev.busy) {
      // Busy -> idle edge: the session just landed a turn, so its transcript
      // grew. Kick an incremental index catch-up now (deduped, background) so
      // the next transcript load serves straight from SQLite — even for
      // sessions nobody has open in the live view. Fires on the raw edge, not
      // the settled one: mid-episode idle gaps just mean we index sooner.
      void (async () => {
        try {
          const tp = s.transcriptPath ?? (await resolveTranscript(id));
          if (tp) enqueueTranscriptIndex(tp, id);
        } catch {
          // indexing is best-effort; never disturb the watcher loop
        }
      })();
    }
    prev.busy = false;
    prev.idleStreak += 1;
    if (prev.pendingComplete && prev.idleStreak >= SETTLE_TICKS) {
      prev.pendingComplete = false;
      emit({
        type: "completed",
        sessionId: id,
        title: (s.title || s.tmuxName || id.slice(0, 8)).slice(0, 120),
        user: s.assignedUser ?? null,
        at: Date.now(),
      });
    }
  }

  // Drop state for sessions that disappeared (closed) so the map can't grow
  // unbounded and a recycled id starts clean.
  for (const id of state.keys()) if (!seen.has(id)) state.delete(id);
}

let started = false;

/**
 * Start the process-global fleet watcher. Idempotent — calling it more than
 * once is a no-op, so it's safe to invoke unconditionally at server boot.
 */
export function startFleetWatcher(): void {
  if (started) return;
  started = true;
  // Fire-and-forget loop; each tick swallows its own errors. We deliberately
  // chain with setTimeout (not setInterval) so a slow listSessions can never
  // overlap itself.
  const loop = async () => {
    await tick();
    setTimeout(loop, TICK_MS);
  };
  setTimeout(loop, TICK_MS);
}
