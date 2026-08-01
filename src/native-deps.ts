// Deferred loading for the two heavyweight native dependencies.
//
// `sharp` and `playwright` each carry a large native addon plus a wide JS
// module graph. Importing them costs roughly 100 MB and 90 MB of RSS
// respectively, measured as the delta over a bare `Bun.serve` process — and
// that cost is paid at import time, whether or not the process ever encodes an
// image or drives a browser.
//
// `lfg serve` reaches both transitively (artifact previews pull sharp; the
// browser-login endpoints pull playwright), so a plain top-level import made
// every server pay ~190 MB before serving its first request. On a 512 MiB
// free-plan Cloud Computer guest that is most of the budget, and it left too
// little headroom for a coding agent to run alongside: opencode was OOM-killed
// shortly after launch on box3 (finding 455c98f58649).
//
// Loading them on first use keeps the idle server small. The vast majority of
// sessions never touch either path, and the ones that do pay the import once —
// the module registry caches it, and these helpers cache the promise so
// concurrent callers share a single load.
//
// Import *types* from the packages directly (`import type`), which erases at
// compile time; only value access needs to route through here.

let sharpPromise: Promise<typeof import("sharp").default> | null = null;

/** Load `sharp` on demand. Cached, so concurrent callers share one import. */
export function loadSharp(): Promise<typeof import("sharp").default> {
  sharpPromise ??= import("sharp").then((m) => m.default);
  return sharpPromise;
}

let chromiumPromise: Promise<typeof import("playwright").chromium> | null = null;

/** Load playwright's `chromium` on demand. Cached like `loadSharp`. */
export function loadChromium(): Promise<typeof import("playwright").chromium> {
  chromiumPromise ??= import("playwright").then((m) => m.chromium);
  return chromiumPromise;
}
