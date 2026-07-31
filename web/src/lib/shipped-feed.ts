// One poller for the head of /api/shipped.
//
// Two surfaces want the newest ship posts: the Notification Center and the
// "recently shipped" rows in the Live sidebar. They each ran their own 15s
// interval on unsynchronised timers (limit=15 and limit=25, both with
// `cache: "no-store"`), and a boot-time idle prefetch added a third request —
// so a single tab could fire three overlapping fetches for one piece of state,
// and the sidebar kept polling even while its pane was closed.
//
// This module owns a single in-flight request and a single interval, fans the
// result out to every subscriber, and stops entirely when nothing is
// subscribed or the tab is hidden. Paging past the head ("load more") stays
// with the caller — only the head is shared, because only the head changes.

import { api } from "./lfg-client";
import { readFeedCache, writeFeedCache, SHIPPED_FEED_KEY } from "./feed-cache";

/** Covers both consumers: the feed's first page and the sidebar's scan window
 *  (which needs headroom to find five *distinct* sessions). */
export const SHIPPED_HEAD_LIMIT = 25;
const POLL_MS = 15_000;

/** Success carries the page; failure carries a message so a surface with no
 *  cached paint can say so instead of showing an empty feed. */
export type ShippedHeadResult<T> =
  | { ok: true; posts: T[]; total: number }
  | { ok: false; error: string };

type Listener = (result: ShippedHeadResult<unknown>) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function emit(result: ShippedHeadResult<unknown>) {
  for (const fn of [...listeners]) {
    try {
      fn(result);
    } catch {
      // A bad subscriber must not stop the others from updating.
    }
  }
}

/** Fetch the head page once, coalescing concurrent callers onto one request. */
export function refreshShippedHead(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = api<{ posts: unknown[]; total?: number }>(
    `/api/shipped?limit=${SHIPPED_HEAD_LIMIT}`,
    { cache: "no-store" },
  )
    .then((data) => {
      // A 2xx body is not a contract: the hosted surface proxies this to a
      // remote workspace, which can answer with an error envelope or `{}`.
      const posts = Array.isArray(data.posts) ? data.posts : [];
      const total = data.total ?? posts.length;
      writeFeedCache(SHIPPED_FEED_KEY, posts, total);
      emit({ ok: true, posts, total });
    })
    .catch((e) => {
      // Subscribers keep their last paint; the next tick retries. Only a
      // surface with nothing cached actually surfaces this.
      emit({
        ok: false,
        error: e instanceof Error ? e.message : "Could not load the shipped feed",
      });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function startTimer() {
  if (timer || typeof document === "undefined") return;
  timer = setInterval(() => {
    // A hidden tab has nothing to repaint; the visibility listener catches up
    // the moment it comes back.
    if (document.visibilityState === "visible") void refreshShippedHead();
  }, POLL_MS);
}

function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function onVisible() {
  if (document.visibilityState === "visible" && listeners.size) {
    void refreshShippedHead();
  }
}

/**
 * Subscribe to the shared head page. Fires immediately with the cached page
 * when one exists (stale-while-revalidate), then on every refresh.
 */
export function subscribeShippedHead<T>(
  fn: (result: ShippedHeadResult<T>) => void,
): () => void {
  const listener = fn as Listener;
  listeners.add(listener);
  if (listeners.size === 1) {
    startTimer();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
  }
  const cached = readFeedCache<T>(SHIPPED_FEED_KEY);
  if (cached) fn({ ok: true, posts: cached.items, total: cached.total });
  void refreshShippedHead();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopTimer();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    }
  };
}
