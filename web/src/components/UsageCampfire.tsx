/**
 * Usage Campfire — full-screen arc of every agent’s rate-limit usage.
 *
 * Desktop: bare Shift toggles the overlay (press again / Esc / click outside
 *          to close). Shift+key or Shift+click does not toggle.
 * Mobile:  long-press the composer activity rings → sticky overlay.
 *
 * Center “campfire” shows time until the next limit window restores.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Flame } from "lucide-react";
import NumberFlow, { NumberFlowGroup } from "@number-flow/react";
import { cn } from "@/lib/utils";
import { haptic } from "@/lib/haptics";

// ── public types (mirror /api/usage) ────────────────────────────────────────

export type UsageWindow = {
  label: string;
  pct: number | null;
  resetsAt: number | null;
};

export type ProviderUsage = {
  kind: string;
  label: string;
  available: boolean;
  plan?: string | null;
  note?: string;
  windows?: UsageWindow[];
};

// ── open bus (avoids wrapping the whole App tree) ───────────────────────────

type CampfireAction = "open" | "close" | "toggle";
type Listener = (action: CampfireAction) => void;

const listeners = new Set<Listener>();

function dispatchCampfire(action: CampfireAction) {
  for (const l of listeners) l(action);
}

/** Open the overlay (mobile long-press, external callers). */
export function openUsageCampfire() {
  dispatchCampfire("open");
}

export function closeUsageCampfire() {
  dispatchCampfire("close");
}

export function toggleUsageCampfire() {
  dispatchCampfire("toggle");
}

// ── constants / helpers ─────────────────────────────────────────────────────

const MAX_RINGS = 4;
const AGENT_ICON_VERSION = "20260718";

// Warm palette (hardcoded — theme tokens go near-black on black in light mode)
const TONE = {
  ok: "#6ee7b7",
  warn: "#fbbf24",
  hot: "#fb7185",
  muted: "rgba(255, 245, 230, 0.45)",
  label: "rgba(255, 245, 230, 0.88)",
  soft: "rgba(255, 245, 230, 0.55)",
  faint: "rgba(255, 245, 230, 0.32)",
} as const;

function agentIconSrc(kind: string): string {
  const v = `?v=${AGENT_ICON_VERSION}`;
  if (kind === "codex" || kind === "codex-aisdk") return `/agent-codex.svg${v}`;
  if (kind === "grok") return `/agent-grok.svg${v}`;
  if (kind === "cursor") return `/agent-cursor.svg${v}`;
  if (kind === "hermes") return `/agent-hermes.svg${v}`;
  if (kind === "opencode") return `/agent-opencode.svg${v}`;
  if (kind === "pi") return `/agent-pi.svg${v}`;
  if (kind === "copilot") return `/agent-copilot.svg${v}`;
  return `/agent-claude.svg${v}`;
}

function isTextEditingElement(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "file", "hidden", "radio", "range", "reset", "submit"].includes(
    el.type,
  );
}

function formatCountdown(ms: number | null, now: number): string {
  if (ms == null) return "—";
  const diff = ms - now;
  if (diff <= 0) return "now";
  const totalSec = Math.round(diff / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) {
    const s = totalSec % 60;
    return s > 0 && mins < 10 ? `${mins}m ${s}s` : `${mins}m`;
  }
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 48) return remM > 0 ? `${hrs}h ${remM}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

/** Remaining time split into clock parts, for the animated hero countdown. */
function countdownParts(ms: number, now: number) {
  const totalSec = Math.max(0, Math.round((ms - now) / 1000));
  return {
    days: Math.floor(totalSec / 86400),
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    seconds: totalSec % 60,
  };
}

/**
 * Hero countdown, ticking to the second. Each unit is its own animated number so
 * only the digits that actually change move — a whole-string swap once a second
 * reads as flicker. Grouped so a rollover (59→00) animates with the unit above
 * it rather than a frame apart.
 */
function HeroCountdown({ resetsAt, now }: { resetsAt: number; now: number }) {
  const { days, hours, minutes, seconds } = countdownParts(resetsAt, now);
  const pad = { minimumIntegerDigits: 2 } as const;
  // A day-scale countdown is a much longer string; step the type down so it
  // still fits a narrow phone.
  const fontSize = days
    ? "clamp(1.9rem, 6vw, 3.1rem)"
    : hours
      ? "clamp(2.3rem, 7.4vw, 3.9rem)"
      : "clamp(2.75rem, 9vw, 4.5rem)";
  return (
    <NumberFlowGroup>
      <span
        className="inline-flex items-baseline tabular-nums"
        style={{
          fontSize,
          // Roomier than the static type was: the digits animate vertically, so
          // a 0.95 line box let them escape the line entirely.
          lineHeight: 1.08,
          // Fade the in/out digits over a taller band, otherwise the hero's glow
          // keeps them legible well outside the line and they read as ghosts.
          ["--number-flow-mask-height" as string]: "0.42em",
        } as React.CSSProperties}
        // The ticking digits would otherwise be announced every second.
        aria-label={formatCountdown(resetsAt, now)}
      >
        {days ? (
          <>
            <NumberFlow value={days} trend={-1} aria-hidden />
            <span style={{ opacity: 0.55 }}>d</span>
            <span className="w-[0.22em]" />
          </>
        ) : null}
        {days || hours ? (
          <>
            <NumberFlow
              value={hours}
              trend={-1}
              format={days ? pad : undefined}
              aria-hidden
            />
            <span style={{ opacity: 0.55 }}>:</span>
          </>
        ) : null}
        <NumberFlow
          value={minutes}
          trend={-1}
          format={days || hours ? pad : undefined}
          aria-hidden
        />
        <span style={{ opacity: 0.55 }}>:</span>
        <NumberFlow value={seconds} trend={-1} format={pad} aria-hidden />
      </span>
    </NumberFlowGroup>
  );
}

function formatResetShort(ms: number | null, now: number): string {
  if (ms == null) return "";
  const c = formatCountdown(ms, now);
  return c === "now" ? "resets now" : `in ${c}`;
}

/** Window to feature on the arc card: highest utilization, then soonest reset. */
function headlineWindow(p: ProviderUsage): UsageWindow | null {
  const windows = p.windows ?? [];
  if (!windows.length) return null;
  return (
    [...windows].sort((a, b) => {
      const ap = a.pct ?? -1;
      const bp = b.pct ?? -1;
      if (bp !== ap) return bp - ap;
      const ar = a.resetsAt ?? Number.POSITIVE_INFINITY;
      const br = b.resetsAt ?? Number.POSITIVE_INFINITY;
      return ar - br;
    })[0] ?? null
  );
}

function soonestReset(providers: ProviderUsage[], now: number): number | null {
  let best: number | null = null;
  for (const p of providers) {
    for (const w of p.windows ?? []) {
      if (w.resetsAt == null || w.resetsAt <= now) continue;
      if (best == null || w.resetsAt < best) best = w.resetsAt;
    }
  }
  return best;
}

function maxUsagePct(p: ProviderUsage): number | null {
  const pcts = (p.windows ?? [])
    .map((w) => w.pct)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (!pcts.length) return null;
  return Math.max(...pcts);
}

/**
 * Elliptical arc above the campfire (CSS: +x right, +y down).
 * Wider than tall so side cards clear the center countdown.
 */
const ARC_X_SCALE_MOBILE = 1.02;
const ARC_X_SCALE_DESKTOP = 1.18;
/** Half the width of an agent node plus breathing room, in px. */
const ARC_NODE_HALF_W = { mobile: 40, desktop: 58 } as const;

function arcLayout(
  count: number,
  radius: number,
  mobile: boolean,
): { x: number; y: number }[] {
  if (count <= 0) return [];
  const startDeg = mobile ? 208 : 198;
  const endDeg = mobile ? 332 : 342;
  const start = (startDeg * Math.PI) / 180;
  const end = (endDeg * Math.PI) / 180;
  const xScale = mobile ? ARC_X_SCALE_MOBILE : ARC_X_SCALE_DESKTOP;
  const yScale = mobile ? 0.78 : 0.82;
  const yLift = mobile ? -radius * 0.18 : -radius * 0.04;
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const a = start + (end - start) * t;
    return {
      x: Math.cos(a) * radius * xScale,
      y: Math.sin(a) * radius * yScale + yLift,
    };
  });
}

function pctColor(pct: number | null): string {
  if (pct == null) return TONE.muted;
  if (pct >= 90) return TONE.hot;
  if (pct >= 70) return TONE.warn;
  return TONE.ok;
}

// ── mini rings ──────────────────────────────────────────────────────────────

function MiniRings({
  windows,
  size = 36,
}: {
  windows: UsageWindow[];
  size?: number;
}) {
  const c = size / 2;
  const sw = size >= 40 ? 3.5 : 2.75;
  const gap = sw + 1.25;
  const outer = c - sw / 2 - 0.5;
  const shown = windows.slice(0, MAX_RINGS);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90 shrink-0"
      aria-hidden
    >
      {shown.map((w, i) => {
        const r = outer - i * gap;
        if (r <= 0) return null;
        const circ = 2 * Math.PI * r;
        const clamped = Math.max(0, Math.min(100, w.pct ?? 0));
        const color = pctColor(w.pct);
        return (
          <g key={w.label}>
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={color}
              strokeOpacity={0.18}
              strokeWidth={sw}
            />
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={sw}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - clamped / 100)}
            />
          </g>
        );
      })}
    </svg>
  );
}

// ── host (mount once near App root) ─────────────────────────────────────────

/**
 * Mount once in the app shell. Owns Shift-toggle, data fetch, and the portal
 * overlay. Other surfaces call `openUsageCampfire()` / `toggleUsageCampfire()`.
 */
export function UsageCampfireHost({
  onSelectAgent,
}: {
  /** Clicking an agent picks it in the composer and opens it. */
  onSelectAgent?: (kind: string) => void;
} = {}) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [radius, setRadius] = useState(160);

  // Bus subscription
  useEffect(() => {
    const onAction: Listener = (action) => {
      setOpen((current) => {
        if (action === "open") return true;
        if (action === "close") return false;
        if (action === "toggle") return !current;
        return current;
      });
    };
    listeners.add(onAction);
    return () => {
      listeners.delete(onAction);
    };
  }, []);

  // Bare Shift toggles. Shift+letter / Shift+click never fires the toggle.
  useEffect(() => {
    let shiftDown = false;
    let contaminated = false;

    const contaminate = () => {
      if (shiftDown) contaminated = true;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        if (!e.repeat) {
          shiftDown = true;
          contaminated = false;
        }
        return;
      }
      // Any other key while Shift is held (Shift+A, Shift+Tab, …) spoils it.
      if (shiftDown || e.shiftKey) contaminated = true;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      const wasClean = shiftDown && !contaminated;
      shiftDown = false;
      contaminated = false;
      if (!wasClean) return;
      if (isTextEditingElement(document.activeElement)) return;
      // Don't steal Shift from open menus / dialogs (except our own overlay,
      // which should toggle closed).
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        !active.closest('[role="dialog"][aria-label="Agent usage"]') &&
        (active.getAttribute("role") === "menuitem" ||
          active.getAttribute("role") === "option" ||
          active.closest("[role='menu'], [role='listbox'], [data-slot='dialog-content']"))
      ) {
        return;
      }
      haptic("medium");
      toggleUsageCampfire();
    };

    const onPointerDown = () => contaminate();
    const onBlur = () => {
      shiftDown = false;
      contaminated = false;
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") {
        shiftDown = false;
        contaminated = false;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeUsageCampfire();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Fetch when opened; refresh while visible.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/usage");
        const data = (await res.json().catch(() => ({}))) as {
          providers?: ProviderUsage[];
        };
        if (cancelled) return;
        if (!res.ok) {
          setError("Couldn't load usage");
          return;
        }
        setProviders(data.providers ?? []);
        setError(null);
      } catch {
        if (!cancelled) setError("Couldn't load usage");
      }
    };
    void load();
    const refresh = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [open]);

  // Live countdown tick.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // Responsive arc radius.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const mobile = w < 768;
      const halfNode = mobile ? ARC_NODE_HALF_W.mobile : ARC_NODE_HALF_W.desktop;
      const xScale = mobile ? ARC_X_SCALE_MOBILE : ARC_X_SCALE_DESKTOP;
      // Widest the arc may be before the end nodes collide with the edge.
      const maxByWidth = (w / 2 - halfNode - 8) / xScale;
      const base = Math.min(maxByWidth, mobile ? h * 0.26 : Math.min(w, h) * 0.3);
      setRadius(Math.round(Math.max(mobile ? 118 : 155, Math.min(245, base))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const close = useCallback(() => closeUsageCampfire(), []);

  if (!open) return null;

  return createPortal(
    <CampfireOverlay
      providers={providers}
      error={error}
      now={now}
      radius={radius}
      onClose={close}
      onSelectAgent={onSelectAgent}
    />,
    document.body,
  );
}

// ── overlay ─────────────────────────────────────────────────────────────────

function CampfireOverlay({
  providers,
  error,
  now,
  radius,
  onClose,
  onSelectAgent,
}: {
  providers: ProviderUsage[] | null;
  error: string | null;
  now: number;
  radius: number;
  onClose: () => void;
  onSelectAgent?: (kind: string) => void;
}) {
  // Only agents that actually report usage. An unconfigured provider has nothing
  // to plot, and a row of greyed-out placeholders was the noisiest thing on the
  // arc — it read as "broken" rather than "not set up".
  const ordered = useMemo(() => {
    if (!providers) return [];
    return providers
      .filter((p) => p.available && (p.windows?.length ?? 0) > 0)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [providers]);

  const [mobile, setMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const loading = providers == null && !error;
  // Lay the skeleton out on the same arc so the real agents don't jump on arrival.
  const nodeCount = loading ? 4 : ordered.length;
  const positions = useMemo(
    () => arcLayout(nodeCount, radius, mobile),
    [nodeCount, radius, mobile],
  );

  // Hovering (or tapping) an agent retargets the centre readout to that agent.
  const [focusKind, setFocusKind] = useState<string | null>(null);
  // Whether this device can hover at all. Checked as a capability rather than
  // inferred from pointer events, which don't reliably report a usable
  // pointerType under touch emulation and on some mobile browsers.
  const [canHover, setCanHover] = useState(
    () => typeof window === "undefined" || window.matchMedia("(hover: hover)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(hover: hover)");
    const sync = () => setCanHover(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // Which agent a touch has armed for launch (see the click handler).
  const armedRef = useRef<string | null>(null);
  const focused = useMemo(
    () => ordered.find((p) => p.kind === focusKind) ?? null,
    [ordered, focusKind],
  );
  const heroReset = useMemo(
    () => soonestReset(focused ? [focused] : ordered, now),
    [focused, ordered, now],
  );
  const heroLabel = useMemo(() => {
    if (heroReset == null) return null;
    for (const p of focused ? [focused] : ordered) {
      for (const w of p.windows ?? []) {
        if (w.resetsAt === heroReset) return `${p.label} · ${w.label}`;
      }
    }
    return null;
  }, [focused, ordered, heroReset]);

  // Not every provider reports a reset time. Rather than answer a hover with
  // "No upcoming resets reported", fall back to what that agent DOES know —
  // how much of its window is spent — and relabel the eyebrow to match.
  const focusHeadline = focused ? headlineWindow(focused) : null;
  const showUsed =
    focused != null && heroReset == null && focusHeadline?.pct != null;

  const stageCenterY = mobile ? "60%" : "55%";
  const logoSize = mobile ? 46 : 64;
  const ringSize = mobile ? 15 : 18;
  const skeletonSize = mobile ? 46 : 64;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Agent usage"
      className="fixed inset-0 z-[180] flex select-none items-center justify-center animate-in fade-in-0 duration-200 [-webkit-touch-callout:none]"
      onClick={onClose}
    >
      {/* Warm ember scrim + vignette — not pure black modal chrome */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 70% 55% at 50% 58%, rgba(255,120,40,0.14) 0%, transparent 55%),
            radial-gradient(ellipse 90% 80% at 50% 100%, rgba(80,30,10,0.45) 0%, transparent 50%),
            linear-gradient(180deg, rgba(11,9,6,0.82) 0%, rgba(11,9,6,0.92) 100%)
          `,
          backdropFilter: "blur(18px) saturate(0.9)",
          WebkitBackdropFilter: "blur(18px) saturate(0.9)",
        }}
      />

      {/* Stage */}
      <div
        className="relative z-10 flex h-[min(92dvh,740px)] w-full max-w-3xl items-center justify-center px-2 sm:px-3"
      >
        {/* Campfire glow — opacity flicker only (no scale bounce) */}
        <div
          className="pointer-events-none absolute left-1/2 z-0 -translate-x-1/2 -translate-y-1/2"
          style={{ top: stageCenterY }}
        >
          <div
            className="absolute left-1/2 top-1/2 size-52 -translate-x-1/2 -translate-y-1/2 rounded-full sm:size-64 md:size-80"
            style={{
              background:
                "radial-gradient(circle, rgba(255,140,50,0.38) 0%, rgba(249,100,25,0.14) 40%, rgba(180,40,10,0.05) 58%, transparent 72%)",
              animation: "lfg-ember-flicker 2.8s ease-in-out infinite",
            }}
          />
          <div
            className="absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full sm:size-28 md:size-36"
            style={{
              background:
                "radial-gradient(circle, rgba(255,210,140,0.5) 0%, rgba(255,140,50,0.18) 48%, transparent 72%)",
              animation: "lfg-ember-flicker 1.7s ease-in-out infinite reverse",
            }}
          />
        </div>

        {/* Centre readout — follows whatever is hovered, else the fleet-wide soonest */}
        <div
          className="pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5 text-center"
          style={{ top: stageCenterY }}
        >
          <div
            className="flex items-center gap-1.5"
            style={{ color: "rgba(253,186,116,0.92)" }}
          >
            <Flame className="size-3.5 sm:size-4" aria-hidden style={{ opacity: 0.9 }} />
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.18em] sm:text-[11px]"
              style={{ letterSpacing: "0.18em" }}
            >
              {showUsed ? "Used" : "Next restore"}
            </span>
          </div>
          <div
            className="font-semibold tabular-nums tracking-tight"
            style={{
              fontSize: "clamp(2.75rem, 9vw, 4.5rem)",
              lineHeight: 0.95,
              minHeight: "1em",
              color: "#fff8f0",
              // Softer than before: the countdown now animates, and a heavy glow
              // made every mid-roll digit smear.
              textShadow:
                "0 0 28px rgba(255,140,50,0.32), 0 0 64px rgba(255,100,20,0.16), 0 2px 10px rgba(0,0,0,0.4)",
            }}
          >
            {loading ? (
              <span
                className="inline-block h-[0.72em] w-[3.2em] rounded-full align-middle"
                style={{
                  background:
                    "linear-gradient(90deg, rgba(255,220,180,0.10) 25%, rgba(255,220,180,0.26) 50%, rgba(255,220,180,0.10) 75%)",
                  backgroundSize: "200% 100%",
                  animation: "lfg-ember-shimmer 1.4s ease-in-out infinite",
                }}
              />
            ) : showUsed && focusHeadline?.pct != null ? (
              `${Math.round(focusHeadline.pct)}%`
            ) : heroReset ? (
              <HeroCountdown resetsAt={heroReset} now={now} />
            ) : (
              "—"
            )}
          </div>
          <p
            className="min-h-[1.15rem] max-w-[16rem] text-[12px] sm:text-[13px]"
            style={{ color: focused ? TONE.label : TONE.soft }}
          >
            {error
              ? error
              : loading
                ? "Reading agent limits…"
                : showUsed && focused && focusHeadline
                  ? `${focused.label} · ${focusHeadline.label}`
                  : heroLabel
                    ? heroLabel
                    : ordered.length
                      ? "No upcoming resets reported"
                      : "No agents reporting usage"}
          </p>
          <p className="mt-0.5 text-[10px]" style={{ color: TONE.faint }}>
            {canHover
              ? onSelectAgent
                ? "Click an agent to start a session · Shift or Esc to close"
                : "Shift to close · Esc"
              : focused && onSelectAgent
                ? `Tap ${focused.label} again to start a session`
                : "Tap outside to close"}
          </p>
        </div>

        {/* Loading skeleton on the arc */}
        {loading
          ? positions.map((pos, i) => (
              <div
                key={`skeleton-${i}`}
                className="lfg-campfire-arc-item absolute z-20 flex flex-col items-center gap-1.5"
                style={
                  {
                    "--lfg-arc-x": `${pos.x}px`,
                    "--lfg-arc-y": `${pos.y}px`,
                    "--lfg-arc-scale": 1,
                    left: `calc(50% + ${pos.x}px)`,
                    top: `calc(${stageCenterY} + ${pos.y}px)`,
                    transform: "translate(-50%, -50%)",
                    animationDelay: `${i * 40}ms`,
                  } as CSSProperties
                }
              >
                <SpinnerRing size={skeletonSize} delayMs={i * 120} />
                <span
                  className="block h-2 w-10 rounded-full sm:w-12"
                  style={{
                    background: "rgba(255,220,180,0.14)",
                    animation: "lfg-ember-shimmer 1.4s ease-in-out infinite",
                    animationDelay: `${i * 120}ms`,
                    backgroundSize: "200% 100%",
                  }}
                />
              </div>
            ))
          : null}

        {/* Agents on the arc — no card chrome, just the meter and its numbers */}
        {ordered.map((p, i) => {
          const pos = positions[i] ?? { x: 0, y: 0 };
          const headline = headlineWindow(p);
          const maxPct = headline?.pct ?? maxUsagePct(p);
          const windows = p.windows ?? [];
          const isFocused = focusKind === p.kind;
          const dimmed = focusKind != null && !isFocused;
          return (
            <button
              key={p.kind}
              type="button"
              aria-label={`${p.label} usage${maxPct == null ? "" : `, ${Math.round(maxPct)} percent`}${onSelectAgent ? " — start a session" : ""}`}
              // Mouse drives focus by hover. Touch can't hover — and a tap emits
              // its own enter/leave pair that would immediately undo the focus —
              // so touch/pen toggle on pointerdown instead.
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") setFocusKind(p.kind);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") {
                  setFocusKind((c) => (c === p.kind ? null : c));
                }
              }}
              onClick={(e) => {
                // The stage itself is the outside-tap target on mobile. Keep
                // taps on an agent inside the interaction instead of letting
                // them bubble up and dismiss the overlay.
                e.stopPropagation();
                if (!onSelectAgent) return;
                // Without hover, a single tap would launch a session before you
                // ever got to read the agent's numbers. So on touch the first tap
                // highlights and retargets the centre readout, and a second tap
                // on the same agent starts the session. Pointer devices keep
                // one-click, because hovering already showed you everything.
                //
                // Armed state is tracked separately from `focusKind`: tapping
                // also focuses the button, so onFocus would have already marked
                // it focused by the time this runs, and the first tap would look
                // like the second.
                if (!canHover && armedRef.current !== p.kind) {
                  armedRef.current = p.kind;
                  setFocusKind(p.kind);
                  return;
                }
                armedRef.current = null;
                onSelectAgent(p.kind);
                onClose();
              }}
              onFocus={() => setFocusKind(p.kind)}
              onBlur={() => setFocusKind((c) => (c === p.kind ? null : c))}
              className={cn(
                "lfg-campfire-arc-item absolute z-20 flex w-[4.6rem] select-none flex-col items-center gap-1 rounded-2xl px-1 py-1.5 sm:w-[6.6rem]",
                onSelectAgent ? "cursor-pointer" : "cursor-default",
                "outline-none transition-[opacity,transform] duration-200 ease-out",
                "focus-visible:ring-2 focus-visible:ring-orange-300/50",
              )}
              style={
                {
                  "--lfg-arc-x": `${pos.x}px`,
                  "--lfg-arc-y": `${pos.y}px`,
                  "--lfg-arc-scale": isFocused ? 1.07 : 1,
                  left: `calc(50% + ${pos.x}px)`,
                  top: `calc(${stageCenterY} + ${pos.y}px)`,
                  transform:
                    "translate(-50%, -50%) scale(var(--lfg-arc-scale))",
                  // Emphasis: the hovered agent stays lit, the rest recede.
                  opacity: dimmed ? 0.42 : 1,
                  animationDelay: `${i * 40}ms`,
                } as CSSProperties
              }
            >
              {/* The logo leads — it's the thing you aim at to start a session. */}
              <img
                src={agentIconSrc(p.kind)}
                alt=""
                className="rounded-xl"
                style={{
                  width: logoSize,
                  height: logoSize,
                  // drop-shadow, not box-shadow: several agent marks are
                  // transparent SVGs, and a box shadow would draw a rectangle
                  // behind the artwork instead of tracing it.
                  filter: isFocused
                    ? "drop-shadow(0 0 10px rgba(255,180,90,0.5)) drop-shadow(0 6px 14px rgba(0,0,0,0.5))"
                    : "drop-shadow(0 4px 10px rgba(0,0,0,0.4))",
                  transition: "filter 200ms ease-out",
                }}
              />
              <div
                className="w-full truncate text-center text-[10px] font-medium sm:text-[11px]"
                style={{ color: TONE.label }}
              >
                {p.label}
              </div>
              {/* Compact meter beside its own number — the ring and the digits
                  describe the same window, so they read as one unit. */}
              <div className="flex items-center justify-center gap-1.5">
                {headline ? (
                  <MiniRings windows={[headline]} size={ringSize} />
                ) : null}
                <span
                  className="font-semibold leading-none tabular-nums"
                  style={{
                    fontSize: mobile ? 14 : 18,
                    color: pctColor(maxPct),
                  }}
                >
                  {maxPct == null ? "—" : `${Math.round(maxPct)}%`}
                </span>
              </div>
              {/* The window name is the non-colour half of the status cue. */}
              {headline ? (
                <div
                  className="w-full truncate text-center text-[9px] leading-tight sm:text-[10px]"
                  style={{ color: TONE.muted }}
                >
                  {headline.label}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>

      <style>{`
        @keyframes lfg-ember-flicker {
          0%, 100% { opacity: 0.78; }
          40% { opacity: 1; }
          70% { opacity: 0.86; }
        }
        @keyframes lfg-ember-spin { to { transform: rotate(360deg); } }
        @keyframes lfg-campfire-arc-fly-out {
          from {
            opacity: 0;
            transform:
              translate(
                calc(-50% - var(--lfg-arc-x)),
                calc(-50% - var(--lfg-arc-y))
              )
              scale(0.72);
          }
          to {
            opacity: 1;
            transform:
              translate(-50%, -50%)
              scale(var(--lfg-arc-scale));
          }
        }
        .lfg-campfire-arc-item {
          animation: lfg-campfire-arc-fly-out 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes lfg-ember-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .lfg-campfire-arc-item {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}

/** Indeterminate ember arc — the "we're still reading limits" state. */
function SpinnerRing({ size, delayMs = 0 }: { size: number; delayMs?: number }) {
  const c = size / 2;
  const sw = size >= 44 ? 3.5 : 2.75;
  const r = c - sw / 2 - 0.5;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="rgba(255,220,180,0.12)"
        strokeWidth={sw}
      />
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="rgba(253,186,116,0.85)"
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={`${circ * 0.24} ${circ}`}
        style={{
          transformOrigin: "50% 50%",
          animation: "lfg-ember-spin 1.15s linear infinite",
          animationDelay: `${delayMs}ms`,
        }}
      />
    </svg>
  );
}

// ── long-press helper for the activity ring button ──────────────────────────

const RING_LONG_PRESS_MS = 420;

/**
 * Pointer handlers that open the campfire on long-press without suppressing
 * short taps (which still open the per-provider dropdown).
 */
export function useUsageRingLongPress(): {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onPointerLeave: (e: ReactPointerEvent) => void;
  /** Call at the start of onClick; returns true if the click should be ignored. */
  shouldSuppressClick: () => boolean;
} {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const suppress = useRef(false);

  const clear = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      suppress.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        suppress.current = true;
        haptic("heavy");
        openUsageCampfire();
      }, RING_LONG_PRESS_MS);
    },
    [clear],
  );

  const end = useCallback(
    (e: ReactPointerEvent) => {
      clear();
      if (fired.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [clear],
  );

  const shouldSuppressClick = useCallback(() => {
    if (!suppress.current) return false;
    suppress.current = false;
    return true;
  }, []);

  return {
    onPointerDown,
    onPointerUp: end,
    onPointerCancel: end,
    onPointerLeave: end,
    shouldSuppressClick,
  };
}
