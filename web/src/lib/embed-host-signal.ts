// Frame → host signalling for embedded LFG (omg's Computer surface).
//
// The reverse direction already exists: the host posts
// `omg:computer-host-resume` and we restart suspended animations (see
// embedded-animation-recovery.ts). This module is the only outbound half —
// LFG tells the host that the framed user just started a session, so the host
// can drive its own post-first-session UX (e.g. an upgrade prompt). LFG owns
// no host state: the payload is one id plus the message tag, and nothing is
// read back.
//
// Origin safety: we never post to "*". The target origin is resolved once at
// module load from, in order,
//   1. `?embedOrigin=<absolute url>` on the frame URL — an explicit opt-in for
//      hosts whose Referrer-Policy strips the referrer, and
//   2. `document.referrer`, but only when it is cross-origin. The router
//      normalizes `?embed=1` to `?embed=true` with a real frame navigation, so
//      after that first hop the referrer is LFG's own previous URL, not the
//      host's — treating that as the host would be wrong.
//   3. the origin resolved on an earlier document of this frame, cached in
//      sessionStorage, which is what survives that same navigation.
// With none of the three we stay silent rather than broadcast.

export const LFG_SESSION_CREATED_MESSAGE = "lfg:session-created";

export type LfgSessionCreatedMessage = {
  type: typeof LFG_SESSION_CREATED_MESSAGE;
  /** LFG session id of the session this frame just created. */
  sessionId: string;
};

export function sessionCreatedMessage(sessionId: string): LfgSessionCreatedMessage {
  return { type: LFG_SESSION_CREATED_MESSAGE, sessionId };
}

/** Origin of an absolute http(s) URL, or null for anything else (relative
 *  URLs, `null` referrers, opaque schemes). */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Resolve the host origin we are allowed to post to. Explicit `embedOrigin`
 *  wins, then a cross-origin referrer, then a previously cached resolution.
 *  Null means "do not post". */
export function resolveHostOrigin(input: {
  search?: string | null;
  referrer?: string | null;
  /** This frame's own origin — a referrer matching it is our own navigation. */
  selfOrigin?: string | null;
  /** Origin resolved on an earlier document of this frame. */
  cached?: string | null;
}): string | null {
  let explicit: string | null = null;
  try {
    explicit = new URLSearchParams(input.search ?? "").get("embedOrigin");
  } catch {
    explicit = null;
  }
  const fromParam = originOf(explicit);
  if (fromParam) return fromParam;
  const fromReferrer = originOf(input.referrer);
  if (fromReferrer && fromReferrer !== input.selfOrigin) return fromReferrer;
  return originOf(input.cached);
}

const HOST_ORIGIN_CACHE_KEY = "lfg_embed_host_origin";

function readCachedHostOrigin(): string | null {
  try {
    return window.sessionStorage?.getItem(HOST_ORIGIN_CACHE_KEY) ?? null;
  } catch {
    return null;
  }
}

function cacheHostOrigin(origin: string): void {
  try {
    window.sessionStorage?.setItem(HOST_ORIGIN_CACHE_KEY, origin);
  } catch {
    // private mode / blocked storage: the param path still works
  }
}

type PostTarget = { postMessage: (message: unknown, targetOrigin: string) => void };

/**
 * Post the session-created signal to the embedding host. Returns true when a
 * message was actually sent, so callers/tests can assert the guards:
 * embedded-only, real session id, a parent that is not us, resolved origin.
 */
export function postSessionCreatedToHost(
  sessionId: string,
  ctx: {
    embedded: boolean;
    parent: PostTarget | null | undefined;
    self?: unknown;
    origin: string | null;
  },
): boolean {
  if (!ctx.embedded) return false;
  if (!sessionId) return false;
  if (!ctx.parent) return false;
  if (ctx.self !== undefined && ctx.parent === ctx.self) return false;
  if (!ctx.origin) return false;
  try {
    ctx.parent.postMessage(sessionCreatedMessage(sessionId), ctx.origin);
  } catch {
    return false;
  }
  return true;
}

// Resolved once per document, then cached for the frame: the router's
// `?embed=1` → `?embed=true` rewrite navigates the frame, which drops
// unrecognized params and replaces the referrer with LFG's own URL.
const bootHostOrigin: string | null = (() => {
  if (typeof window === "undefined") return null;
  const cached = readCachedHostOrigin();
  const resolved = resolveHostOrigin({
    search: window.location?.search,
    referrer: typeof document === "undefined" ? null : document.referrer,
    selfOrigin: window.location?.origin ?? null,
    cached,
  });
  if (resolved && resolved !== cached) cacheHostOrigin(resolved);
  return resolved;
})();

/** Browser entry point: emit the signal for a session this tab just created. */
export function emitSessionCreatedToHost(sessionId: string, embedded: boolean): boolean {
  if (typeof window === "undefined") return false;
  return postSessionCreatedToHost(sessionId, {
    embedded,
    parent: window.parent,
    self: window,
    origin: bootHostOrigin,
  });
}
