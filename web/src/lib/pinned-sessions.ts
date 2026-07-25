export function retainLivePinnedSessions(
  pinnedSessionIds: string[],
  liveSessionIds: readonly string[],
): string[] {
  const live = new Set(liveSessionIds);
  return pinnedSessionIds.filter((sessionId) => live.has(sessionId));
}
