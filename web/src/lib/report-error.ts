// Frontend error auto-reporting. Uncaught errors (window.onerror), unhandled
// promise rejections, and React error-boundary catches are funneled to
// POST /api/client-error, where the backend stores them, surfaces a finding +
// push, and dispatches an auto-fix agent.
//
// Two hard rules keep this safe:
//   1. It must NEVER throw or reject — a reporter that errors would re-trigger
//      the very handlers it lives in (infinite loop). Everything is wrapped and
//      failures are swallowed.
//   2. It must NOT flood. A render loop can fire thousands of errors a second;
//      we dedup by signature and cap total reports per page load.
//
// We only report SHIPPED builds (a hashed entry chunk is present). In dev there
// is no build id — Vite/HMR errors are transient and the person editing already
// sees them — so we stay quiet and just log.

// The hashed entry chunk this document loaded, e.g. "index-ab12cd.js". Present
// only in a production `vite build`; null under dev/HMR. Mirrors main.tsx.
const BUILD_ID =
  document
    .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
    ?.src.match(/index-[\w-]+\.js/)?.[0] ?? null;

const MAX_REPORTS_PER_LOAD = 10;
const sent = new Set<string>();
let count = 0;
let installed = false;

// Browser-native messages for a code-split chunk that failed to load. Each
// engine phrases it differently:
//   • WebKit/Safari: "Importing a module script failed."
//   • Chrome:        "Failed to fetch dynamically imported module: <url>"
//   • Firefox:       "error loading dynamically imported module: <url>"
//   • Vite:          "Unable to preload CSS for <url>"
//   • stale chunk served index.html (our SPA fallback) → a MIME-type refusal:
//     "Failed to load module script: Expected a JavaScript module script but the
//      server responded with a MIME type of \"text/html\"."
// These are almost never a code bug: the client is running a PREVIOUS build and
// asked for a hashed chunk the server no longer has (the SPA server returns
// index.html, which won't parse as a module), or the network blipped mid-import.
// lazyWithReload already recovers imports that route through it, but the same
// failure can reach us via the error boundary / window.onerror / unhandledrejection,
// where — left alone — it raises a finding and dispatches an auto-fix agent
// against a phantom bug. We detect it and recover the same way: one full-page
// reload to pull the fresh index.html and its current chunk hashes.
const CHUNK_LOAD_ERROR =
  /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|unable to preload css|failed to load module script|expected a javascript module script but the server responded/i;

// Key the latch by BUILD_ID so the "at most one recovery reload" guarantee is
// scoped to the build that failed, not the whole browser session. A long-lived
// PWA spans MANY deploys; a single session-wide latch would fire its one reload
// on the first-ever stale chunk and then misclassify every LATER post-deploy
// stale chunk as a durable break — escalating a transient, self-healing
// condition into a phantom finding + auto-fix run. Per-build keying mirrors
// lazyWithReload's per-chunk latch: a genuine break reloads onto the SAME build
// (latch already set → stop, no loop), while a post-deploy stale chunk reloads
// onto a NEW build id (fresh latch → recover again).
const RELOAD_LATCH = `lfg:chunk-reload:__report:${BUILD_ID ?? "dev"}`;

// Returns true if the error was a chunk-load failure we handled (the caller must
// then NOT report it). A per-build latch forces at most ONE recovery reload per
// build: if we already reloaded onto this same build and the chunk STILL won't
// load, it's a genuine, durable break (not a stale chunk) — return false so it
// surfaces as a real finding.
function recoverFromChunkLoadError(message: string): boolean {
  if (!CHUNK_LOAD_ERROR.test(message)) return false;
  let alreadyReloaded = false;
  try {
    alreadyReloaded = sessionStorage.getItem(RELOAD_LATCH) === "1";
    if (!alreadyReloaded) sessionStorage.setItem(RELOAD_LATCH, "1");
  } catch {
    // sessionStorage can throw (private mode / disabled). Treat as "not yet
    // reloaded" and fall through to the reload — recovering is worth more than
    // the small risk of a second reload when storage is unavailable.
  }
  if (alreadyReloaded) return false; // reload didn't help → let it report
  if (typeof window !== "undefined") {
    try {
      window.location.reload();
    } catch {
      /* ignore — nothing more we can do */
    }
  }
  return true; // reloading onto the fresh build; swallow this report
}

function sig(message: string, extra = ""): string {
  return (message + "|" + extra).replace(/\s+/g, " ").trim().slice(0, 300);
}

type Report = {
  message: string;
  stack?: string;
  componentStack?: string;
  source?: string;
  line?: number;
  col?: number;
  kind?: "error" | "unhandledrejection" | "react";
};

/** Report a frontend error. Safe to call from anywhere; never throws. */
export function reportError(r: Report): void {
  try {
    if (!BUILD_ID) {
      // dev / unbuilt — log only, don't spam the findings feed
      if (r.message) console.error("lfg client error (dev, not reported):", r.message);
      return;
    }
    // A mid-recovery throw from lazyWithReload (the page is already reloading) —
    // suppress it so the transient state never becomes a finding.
    if (r.message.startsWith("Reloading to recover stale chunk")) return;
    // A stale/failed code-split chunk → recover with a one-time reload instead of
    // escalating a transient, self-healing condition into a phantom auto-fix run.
    if (recoverFromChunkLoadError(r.message)) return;
    if (count >= MAX_REPORTS_PER_LOAD) return;
    const key = sig(r.message, r.source ?? (r.stack ?? "").split("\n")[1] ?? "");
    if (sent.has(key)) return;
    sent.add(key);
    count++;

    const body = {
      ...r,
      url: location.href,
      userAgent: navigator.userAgent,
      buildId: BUILD_ID,
    };
    // Fire-and-forget. keepalive lets it survive a navigation/reload triggered
    // by the error. Any failure is swallowed — never re-enter the handlers.
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // reporting must never itself throw
  }
}

/** Install global error + unhandledrejection listeners. Idempotent. */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (ev: ErrorEvent) => {
    // Resource load errors (img/script failing) also fire 'error' but have no
    // ev.error and bubble from the element — ignore those, we only want JS.
    if (!ev.message && !ev.error) return;
    reportError({
      kind: "error",
      message: ev.error?.message || ev.message || "Uncaught error",
      stack: ev.error?.stack,
      source: ev.filename,
      line: ev.lineno,
      col: ev.colno,
    });
  });

  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    // A bare DOM Event as the rejection reason is non-actionable noise: it's how
    // libraries (e.g. livekit-client's signal WebSocket, media elements) surface
    // a transient connection/playback error — reject with the raw `error` event.
    // It carries no message or stack and serializes to a useless `{"isTrusted":
    // true}`, yet would still raise a finding + dispatch an auto-fix agent. Drop
    // it, mirroring the resource-load filter in the 'error' handler above.
    if (isUnactionableEvent(reason)) {
      console.debug("lfg: ignored non-error promise rejection", reason);
      return;
    }
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : (() => {
              try {
                return JSON.stringify(reason);
              } catch {
                return String(reason);
              }
            })();
    reportError({
      kind: "unhandledrejection",
      message: message || "Unhandled promise rejection",
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

// A promise rejected with a DOM Event (rather than an Error) is, by construction,
// a failed/aborted *resource* or *transport* — EventSource, WebSocket, media,
// <img>/<script>, WebRTC — typically surfaced from inside a third-party library
// (livekit-client, etc.). It is never a JS logic bug: no stack, no message, and
// it JSON-serializes to the infamous `{"isTrusted":true}`. The owning code
// already recovers (sockets reconnect, media degrades), so escalating it as a
// "frontend error" only spams the feed and dispatches an auto-fix agent against a
// phantom bug. We detect and drop it.
//
// `instanceof Event` alone is not enough: events that cross a realm boundary
// (iframe, or a library's own realm) fail the check yet still serialize to that
// same `{"isTrusted":true}`. So we also structurally match an event-like object —
// an `isTrusted` flag plus a string `type` — which is what actually reached the
// reporter in the wild.
function isUnactionableEvent(reason: unknown): boolean {
  if (typeof Event !== "undefined" && reason instanceof Event) return true;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "isTrusted" in reason &&
    typeof (reason as { type?: unknown }).type === "string"
  );
}
