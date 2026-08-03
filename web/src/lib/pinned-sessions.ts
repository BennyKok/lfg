export function retainLivePinnedSessions(
  pinnedSessionIds: string[],
  liveSessionIds: readonly string[],
): string[] {
  const live = new Set(liveSessionIds);
  return pinnedSessionIds.filter((sessionId) => live.has(sessionId));
}

export function smartClearSessionIds(
  sessions: readonly { sessionId?: string | null; busy?: boolean }[],
  pinnedSessionIds: readonly string[],
): string[] {
  const pinned = new Set(pinnedSessionIds);
  return sessions
    .filter(
      (session): session is { sessionId: string; busy?: boolean } =>
        !!session.sessionId && !session.busy && !pinned.has(session.sessionId),
    )
    .map((session) => session.sessionId);
}
