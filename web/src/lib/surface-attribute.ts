// `<html data-lfg-app-surface>` — the attribute every rule in the packaged
// stylesheet is prefixed with (see vite.lib.config.ts). Without it on the
// document element, a mounted surface renders completely unstyled.
//
// It has to be REFERENCE COUNTED, because a host can have two surfaces alive at
// once. omg keeps the Computer surface (the full app) mounted off-screen while
// you open Settings (a page). Each surface used to set the attribute on mount
// and `delete` it on unmount, so leaving Settings stripped the attribute — and
// with it every style — off the Computer surface that was still mounted and
// still visible. Last one out turns off the lights; the first one out must not.
//
// Deliberately a module-level counter rather than a context: the thing being
// counted is a single attribute on the document, which is genuinely global.
// (Contrast `bare`, which describes a tree and therefore is not — see
// lib/bare-surface.tsx.)

let mounted = 0;

/** Claim the attribute for one surface. Returns the release function. */
export function claimSurfaceAttribute(): () => void {
  mounted += 1;
  if (mounted === 1) {
    document.documentElement.dataset.lfgAppSurface = "";
  }
  let released = false;
  return () => {
    // Strict Mode double-invokes effects; a release that ran twice would
    // decrement past zero and let the next unmount clear the attribute out
    // from under a live surface.
    if (released) return;
    released = true;
    mounted = Math.max(0, mounted - 1);
    if (mounted === 0) {
      delete document.documentElement.dataset.lfgAppSurface;
    }
  };
}
