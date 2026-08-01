// Detect when LFG is framed inside another product (primarily omg's Computer
// surface on sessions.omgs.app). Embedded chrome must stay quiet: no header,
// settings, user picker, or first-run onboarding — the host owns account UX
// and the iframe should show all sessions by default.
//
// Two signals, either is enough:
//   1. Explicit `?embed=1` from the host (omg always sets this on mint).
//   2. Running inside a cross-origin iframe (`window.self !== window.top`).
//      Cross-origin parents throw on `window.top` access in some browsers —
//      treat that as embedded too.

/** True when the URL (or a forced search object) requests embed mode. */
export function embedSearchFlag(
  search: { embed?: boolean | string | number } | null | undefined,
): boolean {
  const v = search?.embed;
  if (v === true || v === 1 || v === "1" || v === "true") return true;
  return false;
}

/** True when this document is running inside a frame. Safe under cross-origin parents. */
export function isFramed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** Read embed intent from the current location before React search is ready. */
export function readLocationEmbedFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("embed") === "1" || q.get("embed") === "true") return true;
  } catch {
    // ignore malformed location
  }
  return isFramed();
}

/** Combined embed detection for App shell decisions. */
export function isEmbedded(
  search?: { embed?: boolean | string | number } | null,
): boolean {
  if (embedSearchFlag(search)) return true;
  if (search == null && typeof window !== "undefined") {
    return readLocationEmbedFlag();
  }
  return isFramed();
}
