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

// A "bare" surface is a host mounting one LFG page inside its own product
// chrome — omg's Settings mounting the machine's settings, for example. The
// host already renders a header, a back affordance and the signed-in account,
// so LFG must not render its own: two brand marks and two identity blocks on
// one page is exactly the duplication that mounting is supposed to remove.
//
// Module-level rather than context because the decision is made once, by the
// package entry point, before any React tree exists — and it never changes for
// the lifetime of that surface.
let bareSurface = false;

/** Called by the package entry point before the router mounts. */
export function setBareSurface(value: boolean): void {
  bareSurface = value;
}

/**
 * True when LFG is rendering a single page inside a host's own chrome.
 *
 * `?bare=1` is honoured as well so the hosted layout can be inspected in a
 * plain browser, without building the package and mounting it in the host.
 */
export function isBareSurface(): boolean {
  if (bareSurface) return true;
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("bare") === "1";
  } catch {
    return false;
  }
}
