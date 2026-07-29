type ShippedSessionLike = {
  sessionId?: string;
  project?: string;
  ts: number;
};

export function latestDistinctShippedSessions<T extends ShippedSessionLike>(
  posts: T[],
  limit = 5,
  project = "__all",
): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];

  for (const post of [...posts].sort((a, b) => b.ts - a.ts)) {
    if (project !== "__all" && post.project !== project) continue;
    if (!post.sessionId || seen.has(post.sessionId)) continue;
    seen.add(post.sessionId);
    latest.push(post);
    if (latest.length === limit) break;
  }

  return latest;
}
