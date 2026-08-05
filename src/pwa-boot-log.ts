/**
 * PWA launch telemetry — how far did an install actually get?
 *
 * A home-screen web app that fails to load shows a silent black window on iOS:
 * no error page, no console, no way for in-page recovery UI to run (the page
 * never ran). Every fix for "my PWA is black" is therefore a guess unless we
 * can answer one question from the server side: *did the phone reach us at
 * all, and how far did it get?*
 *
 * Two independent signals feed one ring buffer:
 *
 *   1. Request marks (server-side, always available). Recorded for the paths a
 *      launch must hit — the document, the service worker, the manifest, the
 *      entry chunk. These land even when the page never executes a single byte
 *      of JavaScript, which is exactly the black-screen case.
 *   2. Boot beacons (page-side). index.html reports phases as it progresses:
 *      html parsed, DOM ready, app mounted, stuck, failed. A launch that logs
 *      a document request but no `app-mounted` beacon narrows the fault to the
 *      bundle; a launch with no entries at all was never a page problem.
 *
 * In-memory and bounded on purpose: this is a live debugging aid, not an audit
 * log, and it must never grow without limit or survive as stale state.
 */

/** Enough to cover several launch attempts plus their sub-resources. */
export const MAX_ENTRIES = 400;

export type BootEntry = {
  /** Epoch ms. */
  t: number;
  /** "request" for a server-side mark, "beacon" for a page report. */
  source: "request" | "beacon";
  /** Request path kind, or beacon phase name. */
  label: string;
  /** Correlates every entry from a single launch, when the page supplies one. */
  bootId?: string;
  ua?: string;
  /** "standalone" | "browser" | "minimal-ui" — page-reported display mode. */
  mode?: string;
  detail?: Record<string, unknown>;
  /** How many identical marks collapsed into this entry (see `record`). */
  repeat?: number;
};

const entries: BootEntry[] = [];

/**
 * Window in which an identical request mark counts as a repeat rather than a
 * new event. Comfortably wider than the 60s service-worker update poll, which
 * would otherwise bury a launch under hundreds of identical `/sw.js` rows —
 * every open tab produces one every minute, including tabs on machines that are
 * working perfectly.
 */
const COLLAPSE_MS = 90_000;

export function record(entry: BootEntry): void {
  // Only request marks collapse. Beacons describe one launch's progress, so
  // folding them together would destroy the sequence the verdict reads.
  if (entry.source === "request") {
    const last = entries[entries.length - 1];
    if (
      last &&
      last.source === "request" &&
      last.label === entry.label &&
      last.ua === entry.ua &&
      entry.t - last.t < COLLAPSE_MS
    ) {
      last.repeat = (last.repeat ?? 1) + 1;
      last.t = entry.t;
      return;
    }
  }
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

/** Newest first. */
export function snapshot(): BootEntry[] {
  return [...entries].reverse();
}

export function clear(): void {
  entries.length = 0;
}

/**
 * Paths worth a mark. Deliberately narrow: logging every asset would bury the
 * launch itself in noise, and only these four say anything about how far a cold
 * start got.
 */
export function launchPathKind(path: string): string | null {
  if (path === "/" || path === "/index.html") return "document";
  if (path === "/sw.js") return "service-worker";
  if (path === "/manifest.webmanifest") return "manifest";
  // The entry chunk — Vite content-hashes it, so match the stable prefix.
  if (/^\/assets\/index-[^/]+\.js$/.test(path)) return "entry-chunk";
  return null;
}

/**
 * Client hints a launch failure depends on. `Sec-Fetch-Dest: document` proves a
 * top-level navigation rather than a fetch from an already-running page, which
 * is how we tell "iOS actually cold-launched the icon" from "the app was
 * already open and polled us".
 */
export function requestDetail(headers: Headers): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  const dest = headers.get("sec-fetch-dest");
  const mode = headers.get("sec-fetch-mode");
  const site = headers.get("sec-fetch-site");
  if (dest) detail.dest = dest;
  if (mode) detail.mode = mode;
  if (site) detail.site = site;
  return detail;
}

export function recordRequest(path: string, headers: Headers): void {
  const kind = launchPathKind(path);
  if (!kind) return;
  record({
    t: Date.now(),
    source: "request",
    label: kind,
    ua: headers.get("user-agent") || undefined,
    detail: requestDetail(headers),
  });
}

const ALLOWED_PHASES = new Set([
  "html-parsed",
  "dom-ready",
  "app-mounted",
  "sw-registered",
  "sw-failed",
  "asset-error",
  "stuck",
  "page-error",
]);

/**
 * Parse a beacon body. `navigator.sendBeacon` sends text/plain, so the body is
 * a JSON *string* rather than a parsed object, and it arrives from a page we
 * cannot trust to be well-formed — a black-screen install is by definition
 * misbehaving. Everything is validated and clamped rather than assumed.
 */
export function parseBeacon(body: string, ua?: string): BootEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const phase = typeof obj.phase === "string" ? obj.phase : "";
  if (!ALLOWED_PHASES.has(phase)) return null;

  const str = (v: unknown, max: number) =>
    typeof v === "string" && v.length ? v.slice(0, max) : undefined;

  const detail: Record<string, unknown> = {};
  if (obj.detail && typeof obj.detail === "object") {
    for (const [k, v] of Object.entries(obj.detail as Record<string, unknown>)) {
      if (Object.keys(detail).length >= 12) break;
      detail[k.slice(0, 40)] =
        typeof v === "number" || typeof v === "boolean" ? v : String(v).slice(0, 300);
    }
  }

  return {
    t: Date.now(),
    source: "beacon",
    label: phase,
    bootId: str(obj.bootId, 40),
    mode: str(obj.mode, 20),
    ua: str(obj.ua, 300) || ua,
    detail,
  };
}

export type LaunchVerdict = {
  headline: string;
  explanation: string;
  /** Surfaced separately when the log cannot answer the question being asked. */
  note?: string;
};

/** Display modes that mean "launched from the Home Screen", not a browser tab. */
const INSTALLED_MODES = new Set(["standalone", "minimal-ui", "fullscreen"]);

type Launch = {
  bootId: string;
  mode?: string;
  labels: Set<string>;
  lastT: number;
};

/**
 * Group beacons into individual launches.
 *
 * Judging the log as one undifferentiated pile is actively misleading: a laptop
 * tab that works fine contributes an `app-mounted`, which would report success
 * while the phone next to it is still black. A verdict is only meaningful about
 * one launch at a time.
 */
export function launches(entries: BootEntry[]): Launch[] {
  const byId = new Map<string, Launch>();
  for (const e of entries) {
    if (e.source !== "beacon" || !e.bootId) continue;
    const existing = byId.get(e.bootId);
    if (existing) {
      existing.labels.add(e.label);
      existing.lastT = Math.max(existing.lastT, e.t);
      existing.mode ??= e.mode;
    } else {
      byId.set(e.bootId, {
        bootId: e.bootId,
        mode: e.mode,
        labels: new Set([e.label]),
        lastT: e.t,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.lastT - b.lastT);
}

/**
 * Turn the raw log into the one sentence the user actually needs.
 *
 * Reports on a *single* launch — the newest home-screen one if any exists,
 * otherwise the newest browser one — because those two can disagree completely,
 * and the home-screen case is the one being debugged.
 */
export function verdict(all: BootEntry[], windowMs = 15 * 60_000): LaunchVerdict {
  const cutoff = Date.now() - windowMs;
  const recent = all.filter((e) => e.t >= cutoff);

  if (recent.length === 0) {
    return {
      headline: "No launch reached this server",
      explanation:
        "Nothing arrived in the last 15 minutes — not even a request for the page. " +
        "The phone never got a connection, so this is the network path (Tailscale " +
        "down, or not up yet at the moment of launch), not the app. No amount of " +
        "service-worker or cache fixing can change this.",
    };
  }

  const all_ = launches(recent);
  const installed = all_.filter((l) => l.mode && INSTALLED_MODES.has(l.mode));
  const target = installed.at(-1) ?? all_.at(-1);

  const note = installed.length
    ? undefined
    : "No home-screen launch has reported in yet — every report below came from a " +
      "browser tab. Open the Home Screen icon (not Safari) to test the install itself.";

  if (!target) {
    const sawDocument = recent.some((e) => e.source === "request" && e.label === "document");
    if (!sawDocument) {
      return {
        headline: "Sub-resources only — no page request",
        explanation:
          "Something talked to the server, but nothing requested the page itself. " +
          "Usually a stuck service worker answering the navigation, or a start_url " +
          "pointing somewhere else.",
        note,
      };
    }
    return {
      headline: "Page fetched, but never executed",
      explanation:
        "The server sent the document, yet the page never reported in. The response is " +
        "not reaching the renderer intact — a truncated or blocked response, or a " +
        "cancelled launch (an iOS cold start racing the VPN does exactly this).",
      note,
    };
  }

  const where = target.mode && INSTALLED_MODES.has(target.mode) ? "home-screen app" : "browser tab";
  if (target.labels.has("app-mounted")) {
    return {
      headline: `The app mounted (${where})`,
      explanation:
        "The page loaded and React mounted, so a black screen here is a rendering or " +
        "layout problem inside the app — not the install, the worker, or the network.",
      note,
    };
  }
  if (target.labels.has("stuck")) {
    return {
      headline: `Loaded, but never mounted (${where})`,
      explanation:
        "The document ran and reported itself stuck on the splash after the boot " +
        "timeout, and never mounted. The app bundle is not arriving or not evaluating " +
        "— check for asset-error entries, and whether an entry-chunk request was even made.",
      note,
    };
  }
  return {
    headline: `Page ran, then went quiet (${where})`,
    explanation:
      "The document parsed and reported in, but never mounted and never reported stuck. " +
      "The app bundle most likely failed to download or evaluate.",
    note,
  };
}
