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
// NOT a mutable module flag any more. It was one — set by the package entry
// point before any React tree exists — which is correct for one surface per
// document and wrong the moment a host mounts two. omg keeps the Computer
// surface (full app) alive off-screen while you open Settings (a bare page), so
// both exist at once and one global cannot describe both: opening settings once
// left every later full-app render bare, stripped of its header, gutter and
// header inset until a hard reload. Each tree declares its own now, through
// BareSurfaceProvider in lib/bare-surface.tsx.
//
// What survives here is the URL escape hatch below, which belongs to the
// document rather than to a tree.

/**
 * `?bare=1` — inspect the hosted layout in a plain browser, without building
 * the package and mounting it in a host. Prefer useBareSurface() in components:
 * inside a surface the tree's own value wins, and this is only its fallback.
 */
export function isBareSurface(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("bare") === "1";
  } catch {
    return false;
  }
}
