import type { LfgChatMessage } from "./lfg-chat-transport";

// Session-switch transcript cache.
//
// Opening a session used to blank the pane and wait on a fresh
// `/api/sessions/{id}/messages` round trip every single time — including for a
// session you had open seconds ago. The server page itself is sub-millisecond,
// so that wait was pure network latency, and it read as "transcript loading is
// slow" whenever the link was slow (remote/tunnelled/mobile).
//
// We keep the last-known page per session in memory so a re-open paints
// instantly from cache and revalidates in the background (stale-while-
// revalidate). Live transcript events keep the cached entry current while the
// session stays mounted, so the cached paint is usually already correct.

export type TranscriptCacheEntry = {
  messages: LfgChatMessage[];
  nextBefore: number | null;
  at: number;
};

// Bounded so a long-lived tab that visits many sessions can't grow without
// limit; insertion-ordered Map = cheap LRU when we re-set on read.
const MAX_SESSIONS = 24;
const cache = new Map<string, TranscriptCacheEntry>();

function trim() {
  for (const sid of cache.keys()) {
    if (cache.size <= MAX_SESSIONS) return;
    cache.delete(sid);
  }
}

export function readTranscriptCache(sid: string): TranscriptCacheEntry | null {
  const entry = cache.get(sid);
  if (!entry) return null;
  // Refresh LRU position on read.
  cache.delete(sid);
  cache.set(sid, entry);
  return entry;
}

export function writeTranscriptCache(
  sid: string,
  messages: LfgChatMessage[],
  nextBefore: number | null,
) {
  if (!sid) return;
  cache.delete(sid);
  cache.set(sid, { messages, nextBefore, at: Date.now() });
  trim();
}

// Keep the cached page in sync as live events land, without disturbing LRU
// order or creating an entry for a session we never loaded a page for.
export function updateTranscriptCacheMessages(sid: string, messages: LfgChatMessage[]) {
  const entry = cache.get(sid);
  if (!entry) return;
  entry.messages = messages;
  entry.at = Date.now();
}

// How many of the top-of-list sessions to warm ahead of the user opening them.
const PREFETCH_COUNT = 8;

// Module-level, not a component ref: the app remounts (e.g. after picking a
// profile) and a per-instance ref would re-run the whole prefetch sweep.
const attempted = new Set<string>();
const queue: string[] = [];
let sweeping = false;

// `requestIdleCallback` where available, timeout fallback for Safari. Keeps
// prefetch off the critical path of the list's first paint.
function whenIdle(run: () => void) {
  const ric = (
    globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  ).requestIdleCallback;
  if (typeof ric === "function") ric(run, { timeout: 2000 });
  else setTimeout(run, 500);
}

/**
 * Warm the cache for the first few sessions in the order the user actually sees
 * them, so the *first* open of a session paints instantly too — not just
 * re-opens. Best-effort and idempotent: every sid is attempted at most once,
 * and a page the user's own open already wrote is never clobbered.
 */
export function prefetchTranscripts(
  orderedSids: string[],
  load: (sid: string) => Promise<{ messages: LfgChatMessage[]; nextBefore: number | null }>,
) {
  for (const sid of orderedSids
    .filter((sid) => sid && !attempted.has(sid) && !cache.has(sid))
    .slice(0, PREFETCH_COUNT)) {
    if (!queue.includes(sid)) queue.push(sid);
  }
  // Queued rather than dropped: the narrow and wide layouts each report their
  // own on-screen order, and a sweep already running must not discard the other.
  if (!queue.length || sweeping) return;
  sweeping = true;
  whenIdle(async () => {
    try {
      // Serial: background work must never contend with the fetch for a session
      // the user actually opened.
      while (queue.length) {
        const sid = queue.shift() as string;
        if (attempted.has(sid) || cache.has(sid)) continue;
        attempted.add(sid);
        try {
          const page = await load(sid);
          if (cache.has(sid)) continue;
          writeTranscriptCache(sid, page.messages, page.nextBefore);
        } catch {
          // Best-effort; opening the session still fetches normally.
        }
      }
    } finally {
      sweeping = false;
    }
  });
}

export function clearTranscriptCache(sid?: string) {
  if (sid) {
    cache.delete(sid);
    attempted.delete(sid);
    return;
  }
  cache.clear();
  attempted.clear();
  queue.length = 0;
}
