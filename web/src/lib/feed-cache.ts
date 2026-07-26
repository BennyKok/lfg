// Client cache for the Shipped feed and Artifacts gallery.
//
// Those pages used to unmount on every tab switch, drop their React state, and
// re-hit `/api/shipped` / `/api/artifacts` with `cache: "no-store"`. The server
// answers in a couple of milliseconds now, but the blank "Loading…" frame +
// network round trip (and rebooting gallery iframes) still felt slow —
// especially over a tunnel or on mobile.
//
// Same shape as transcript-cache: keep the last-known page in memory so a
// revisit paints instantly, then revalidate in the background (stale-while-
// revalidate). Mutations (delete / refresh / load-more) write back so the
// cached paint stays honest.

export type FeedCacheEntry<T> = {
  items: T[];
  total: number;
  at: number;
};

const cache = new Map<string, FeedCacheEntry<unknown>>();

export function readFeedCache<T>(key: string): FeedCacheEntry<T> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  return entry as FeedCacheEntry<T>;
}

export function writeFeedCache<T>(key: string, items: T[], total: number) {
  cache.set(key, { items, total, at: Date.now() });
}

export function updateFeedCache<T>(
  key: string,
  updater: (prev: FeedCacheEntry<T> | null) => FeedCacheEntry<T> | null,
) {
  const next = updater(readFeedCache<T>(key));
  if (!next) {
    cache.delete(key);
    return;
  }
  cache.set(key, next as FeedCacheEntry<unknown>);
}

export function clearFeedCache(key?: string) {
  if (key) {
    cache.delete(key);
    return;
  }
  cache.clear();
}

// Stable keys for the two gallery surfaces. Include the kind filter so a
// future "images only" view does not collide with the HTML gallery.
export const SHIPPED_FEED_KEY = "shipped:feed";
export const ARTIFACTS_GALLERY_KEY = "artifacts:html";
