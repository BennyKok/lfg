import { listSessions, type Session } from "./sessions.ts";

const LIST_SESSIONS_CACHE_TTL_MS = 900;
const ACTIVE_REFRESH_INTERVAL_MS = 1200;
const ACTIVE_REFRESH_IDLE_MS = 30_000;

let cached: { at: number; sessions: Session[] } | null = null;
let inflight: Promise<Session[]> | null = null;
let recentClientActivityAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function invalidateListSessionsCache(): void {
  cached = null;
}

function setCachedFromInflight(promise: Promise<Session[]>): Promise<Session[]> {
  inflight = promise
    .then((sessions) => {
      cached = { at: Date.now(), sessions };
      return sessions;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function refreshListSessionsCache(): Promise<Session[]> {
  if (inflight) return inflight;
  return setCachedFromInflight(listSessions());
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
  void refreshListSessionsCache().catch(() => {});
}

export function noteListSessionsClientActivity(): void {
  recentClientActivityAt = Date.now();
  if (refreshTimer) return;
  refreshTimer = setInterval(warmRefreshTick, ACTIVE_REFRESH_INTERVAL_MS);
  (refreshTimer as { unref?: () => void }).unref?.();
}

export async function listSessionsCached(): Promise<Session[]> {
  const now = Date.now();
  if (cached && now - cached.at < LIST_SESSIONS_CACHE_TTL_MS) return cached.sessions;
  if (inflight) return inflight;
  return refreshListSessionsCache();
}
