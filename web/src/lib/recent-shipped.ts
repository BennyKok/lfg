type ShippedSessionLike = {
  sessionId?: string;
  ts: number;
};

export function latestDistinctShippedSessions<T extends ShippedSessionLike>(
  posts: T[],
  limit = 5,
): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];

  for (const post of [...posts].sort((a, b) => b.ts - a.ts)) {
    if (!post.sessionId || seen.has(post.sessionId)) continue;
    seen.add(post.sessionId);
    latest.push(post);
    if (latest.length === limit) break;
  }

  return latest;
}
