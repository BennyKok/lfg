import { listSessions, type Session } from "./sessions.ts";

const LIST_SESSIONS_CACHE_TTL_MS = 900;

let cached: { at: number; sessions: Session[] } | null = null;
let inflight: Promise<Session[]> | null = null;

export function invalidateListSessionsCache(): void {
  cached = null;
}

export async function listSessionsCached(): Promise<Session[]> {
  const now = Date.now();
  if (cached && now - cached.at < LIST_SESSIONS_CACHE_TTL_MS) return cached.sessions;
  if (inflight) return inflight;
  inflight = listSessions()
    .then((sessions) => {
      cached = { at: Date.now(), sessions };
      return sessions;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
