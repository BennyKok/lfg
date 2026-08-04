import { listSessions, type Session } from "./sessions.ts";

// Must exceed both the status-broadcast cadence (~1s) and the warm-refresh
// interval below so hot readers (live-ws status loop, monitor) hit a warm cache
// instead of triggering a blocking full rebuild on the event loop.
const LIST_SESSIONS_CACHE_TTL_MS = 3000;
const ACTIVE_REFRESH_INTERVAL_MS = 2500;
const ACTIVE_REFRESH_IDLE_MS = 30_000;

export type SessionListCache = {
  invalidate(): void;
  get(): Promise<Session[]>;
  noteClientActivity(): void;
};

/**
 * Cache in front of the (expensive) session list scan.
 *
 * A scan is a snapshot of the moment it STARTED, not of the moment it finished:
 * listSessions walks the process table and every transcript head, which on a
 * loaded box takes seconds. Two things follow, and both used to be wrong here.
 *
 * 1. The entry is timestamped with `startedAt`. Stamping completion time
 *    credited a 4s scan with 4s of freshness it never had, so a snapshot taken
 *    before a session was created could be served as current for a full TTL
 *    after that session already existed.
 * 2. An in-flight scan that predates an `invalidate()` must not be adopted.
 *    Callers used to join `inflight` unconditionally, so a warm-refresh tick
 *    that began a moment before POST /api/sessions/new added the managed record
 *    would hand its pre-create list to the very refresh the client fires right
 *    after creating — and then install that as fresh. That is one half of the
 *    "I created a session and it takes seconds to show up" report: the create
 *    was instant, the list was not.
 *
 * Taking the scan as a parameter keeps this logic testable with a scan whose
 * start and finish the test controls, without mocking the sessions module.
 */
export function createSessionListCache(scan: () => Promise<Session[]>): SessionListCache {
  let cached: { at: number; sessions: Session[] } | null = null;
  let inflight: { epoch: number; promise: Promise<Session[]> } | null = null;
  let recentClientActivityAt = 0;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  // Bumped by every mutation that changes what a scan would return. A scan only
  // owns the cache if the world has not moved under it since it started.
  let epoch = 0;

  function startScan(): Promise<Session[]> {
    const startedAt = Date.now();
    const scanEpoch = epoch;
    const promise = scan()
      .then((sessions) => {
        if (scanEpoch === epoch) cached = { at: startedAt, sessions };
        return sessions;
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { epoch: scanEpoch, promise };
    return promise;
  }

  function refresh(): Promise<Session[]> {
    if (inflight && inflight.epoch === epoch) return inflight.promise;
    return startScan();
  }

  function stopWarmRefresh(): void {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function warmRefreshTick(): void {
    if (Date.now() - recentClientActivityAt > ACTIVE_REFRESH_IDLE_MS) {
      stopWarmRefresh();
      return;
    }
    void refresh().catch(() => {});
  }

  return {
    invalidate() {
      epoch += 1;
      cached = null;
    },
    get() {
      if (cached && Date.now() - cached.at < LIST_SESSIONS_CACHE_TTL_MS)
        return Promise.resolve(cached.sessions);
      return refresh();
    },
    noteClientActivity() {
      recentClientActivityAt = Date.now();
      if (refreshTimer) return;
      refreshTimer = setInterval(warmRefreshTick, ACTIVE_REFRESH_INTERVAL_MS);
      (refreshTimer as { unref?: () => void }).unref?.();
    },
  };
}

const sessionListCache = createSessionListCache(() => listSessions());

export function invalidateListSessionsCache(): void {
  sessionListCache.invalidate();
}

export function noteListSessionsClientActivity(): void {
  sessionListCache.noteClientActivity();
}

export function listSessionsCached(): Promise<Session[]> {
  return sessionListCache.get();
}
