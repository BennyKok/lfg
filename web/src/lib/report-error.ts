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
