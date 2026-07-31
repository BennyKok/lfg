// Notify when a coding session finishes a turn.
//
// notifyAll() already fires for auto-agent findings, client errors, ask-user
// questions and shipped results. The ordinary case — an agent finishing what
// you asked it to do — had no trigger, so an installed PWA stayed silent for
// the thing you actually wait on.
//
// Nothing new is needed to detect it: the fleet watcher in src/voice-bus.ts
// already samples every session's busy state and emits a settled busy -> idle
// edge, which is exactly "that session just landed a turn". So far only the
// voice worker subscribed. This bridges the same bus to Web Push, using the
// queued-notification path so the notice names the session that caused it.

import { subscribeFleet } from "./voice-bus.ts";
import { isSessionWatched } from "./live-ws.ts";
import { notifyAll } from "./push.ts";
import { listSessionsCached } from "./session-cache.ts";

/**
 * How long to hold a completion back when the session looks like it's on
 * screen. Must clear live-ws's IDLE_CLOSE_MS (60s) — that is how long a
 * suspended client's socket survives before the server reaps it.
 */
const WATCHED_RECHECK_MS = 75_000;

/** First non-empty line, trimmed to notification length. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * What the session has to say for itself: the first line of its last assistant
 * turn, or the reason it is stuck. Read at emit time, which is safe because the
 * watcher only emits after idle has held for SETTLE_TICKS — the turn is written
 * by then.
 */
async function bodyForSession(sessionId: string): Promise<string> {
  try {
    const session = (await listSessionsCached()).find((s) => s.sessionId === sessionId);
    if (session?.status === "blocked") {
      return session.statusDetail || "Session is blocked and needs you.";
    }
    const last = session?.last;
    if (last && last.role === "assistant" && last.kind === "text") {
      const summary = firstLine(last.text);
      if (summary) return summary;
    }
  } catch {
    // Session listing is unavailable — fall through to the generic body.
  }
  return "Finished its turn.";
}

let started = false;

/**
 * Bridge fleet completions to Web Push. Idempotent, so it is safe to call
 * unconditionally at boot alongside startFleetWatcher().
 */
export function startSessionPushBridge(): void {
  if (started) return;
  started = true;
  // Unscoped subscriber: we want every session's completion and do the
  // per-user targeting through notifyAll's own `user` filter.
  subscribeFleet(null, (ev) => {
    if (ev.type !== "completed") return;

    const notify = () =>
      void (async () => {
        await notifyAll({
          user: ev.user,
          notification: {
            title: ev.title,
            body: await bodyForSession(ev.sessionId),
            // Deep-link straight to the session that finished.
            url: `/?session=${encodeURIComponent(ev.sessionId)}`,
            // Per session, so a second completion replaces that session's
            // notice rather than stacking another one behind it.
            tag: `session-${ev.sessionId}`,
          },
        });
      })().catch(() => {});

    if (!isSessionWatched(ev.sessionId)) {
      notify();
      return;
    }

    // The user appears to have this session open, so buzzing now is noise.
    // Defer rather than drop: a phone that suspends holds its socket open for
    // up to IDLE_CLOSE_MS, so "actively watching" and "just locked the screen"
    // are indistinguishable at this instant — and dropping would eat the
    // notification in exactly the case it matters most.
    const timer = setTimeout(() => {
      // Still watching after the socket would have been reaped: they are really
      // there and have already seen it.
      if (isSessionWatched(ev.sessionId)) return;
      notify();
    }, WATCHED_RECHECK_MS);
    // Never let a pending re-check hold the process open at shutdown.
    (timer as { unref?: () => void }).unref?.();
  });
}
