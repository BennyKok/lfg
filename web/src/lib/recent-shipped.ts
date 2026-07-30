type ShippedSessionLike = {
  sessionId?: string;
  project?: string;
  ts: number;
};

/**
 * `posts` is typed as an array but arrives from an HTTP response body, so the
 * type is a promise the network does not have to keep. Spreading `undefined`
 * here threw during render and took the whole app down behind the router's catch
 * boundary — on the hosted surface, where the request is proxied to a remote
 * workspace that can answer 2xx with something other than `{ posts: [...] }`
 * (an error envelope, `{}`, or a wake response while it is still asleep). The
 * caller guards the state too; this guard is the one that cannot be bypassed by
 * a new caller.
 */
export function latestDistinctShippedSessions<T extends ShippedSessionLike>(
  posts: T[] | null | undefined,
  limit = 5,
  project = "__all",
): T[] {
  const seen = new Set<string>();
  const latest: T[] = [];

  for (const post of [...(posts ?? [])].sort((a, b) => b.ts - a.ts)) {
    if (project !== "__all" && post.project !== project) continue;
    if (!post.sessionId || seen.has(post.sessionId)) continue;
    seen.add(post.sessionId);
    latest.push(post);
    if (latest.length === limit) break;
  }

  return latest;
}
