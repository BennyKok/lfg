/**
 * Usage Campfire — hold-to-peek overlay of every agent’s rate-limit usage.
 *
 * Desktop: hold `U` (not while typing) → arc layout appears; release hides it.
 * Mobile:  long-press the composer activity rings → sticky overlay (tap backdrop
 *          or Escape to dismiss).
 *
 * Center “campfire” shows time until the next limit window restores. Each agent
 * sits on an arc around it with its primary window % and per-window resets.
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

type CampfireAction = "peek-on" | "peek-off" | "sticky" | "close";
type Listener = (action: CampfireAction) => void;

const listeners = new Set<Listener>();

function dispatchCampfire(action: CampfireAction) {
  for (const l of listeners) l(action);
}

/** Open sticky (stays until dismissed). Used by mobile long-press on rings. */
export function openUsageCampfire() {
  dispatchCampfire("sticky");
}

/** Hold-to-peek helpers for the global keyboard shortcut. */
export function peekUsageCampfire(held: boolean) {
  dispatchCampfire(held ? "peek-on" : "peek-off");
}

export function closeUsageCampfire() {
  dispatchCampfire("close");
}

// ── constants / helpers ─────────────────────────────────────────────────────

const HOLD_MS = 280;
const RING_COLORS = ["#fb923c", "#38bdf8", "#a78bfa", "#34d399"];
const AGENT_ICON_VERSION = "20260718";

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

function formatResetShort(ms: number | null, now: number): string {
  if (ms == null) return "";
  const c = formatCountdown(ms, now);
  return c === "now" ? "resets now" : `in ${c}`;
}

/** Window to feature on the arc card: highest utilization, then soonest reset. */
function headlineWindow(p: ProviderUsage): UsageWindow | null {
  const windows = p.windows ?? [];
  if (!windows.length) return null;
  return [...windows].sort((a, b) => {
    const ap = a.pct ?? -1;
    const bp = b.pct ?? -1;
    if (bp !== ap) return bp - ap;
    const ar = a.resetsAt ?? Number.POSITIVE_INFINITY;
    const br = b.resetsAt ?? Number.POSITIVE_INFINITY;
    return ar - br;
  })[0] ?? null;
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
 * Arc positions above the campfire (CSS coords: +x right, +y down).
 * Mobile uses a flatter, higher arc so cards clear the center countdown.
 */
function arcLayout(
  count: number,
  radius: number,
  mobile: boolean,
): { x: number; y: number }[] {
  if (count <= 0) return [];
  // Desktop: wide semicircle. Mobile: high flat arc so chips clear the fire.
  const startDeg = mobile ? 205 : 195;
  const endDeg = mobile ? 335 : 345;
  const start = (startDeg * Math.PI) / 180;
  const end = (endDeg * Math.PI) / 180;
  // Lift mobile chips further above the countdown.
  const yLift = mobile ? -radius * 0.22 : 0;
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const a = start + (end - start) * t;
    return { x: Math.cos(a) * radius, y: Math.sin(a) * radius + yLift };
  });
}

function pctTone(pct: number | null): string {
  if (pct == null) return "text-muted-foreground";
  if (pct >= 90) return "text-destructive";
  if (pct >= 70) return "text-amber-500";
  return "text-foreground";
}

// ── mini rings (reuse visual language of the composer indicator) ────────────

function MiniRings({
  windows,
  size = 36,
}: {
  windows: UsageWindow[];
  size?: number;
}) {
  const c = size / 2;
  const sw = size >= 40 ? 3.5 : 3;
  const gap = sw + 1.25;
  const outer = c - sw / 2 - 0.5;
  const shown = windows.slice(0, RING_COLORS.length);
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
        const color = RING_COLORS[i % RING_COLORS.length];
        return (
          <g key={w.label}>
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={color}
              strokeOpacity={0.22}
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
 * Mount once in the app shell. Owns keyboard hold-to-peek, data fetch, and the
 * portal overlay. Other surfaces call `openUsageCampfire()` to open sticky mode.
 */
export function UsageCampfireHost() {
  // null | peek (keyboard hold) | sticky (mobile long-press / explicit open)
  const [mode, setMode] = useState<"peek" | "sticky" | null>(null);
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [radius, setRadius] = useState(150);
  const open = mode != null;

  // Bus subscription
  useEffect(() => {
    const onAction: Listener = (action) => {
      setMode((current) => {
        if (action === "sticky") return "sticky";
        if (action === "close") return null;
        if (action === "peek-on") return current === "sticky" ? "sticky" : "peek";
        // peek-off: only clear peek; sticky stays until dismissed
        if (action === "peek-off") return current === "peek" ? null : current;
        return current;
      });
    };
    listeners.add(onAction);
    return () => {
      listeners.delete(onAction);
    };
  }, []);

  // Hold `U` to peek (ignored while typing in inputs / contenteditable).
  useEffect(() => {
    let timer: number | null = null;
    let engaged = false;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const release = () => {
      clearTimer();
      if (!engaged) return;
      engaged = false;
      peekUsageCampfire(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key.toLowerCase() !== "u") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextEditingElement(document.activeElement)) return;
      // Don't steal "u" from focused buttons/menus that handle their own keys.
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.getAttribute("role") === "menuitem" ||
          active.getAttribute("role") === "option" ||
          active.closest("[role='menu'], [role='listbox'], [data-slot='dialog-content']"))
      ) {
        return;
      }
      e.preventDefault();
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        engaged = true;
        haptic("medium");
        peekUsageCampfire(true);
      }, HOLD_MS);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "u") return;
      release();
    };

    const onBlur = () => release();
    const onVis = () => {
      if (document.visibilityState !== "visible") release();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimer();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Escape dismisses sticky (and peek, as a safety valve).
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

  // Fetch when opened; refresh on a slow interval while visible.
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

  // Responsive arc radius. Mobile cards are compact chips, so we can push them
  // out toward the edges without overflowing the viewport.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const mobile = w < 768;
      const base = mobile ? Math.min(w * 0.44, h * 0.3) : Math.min(w, h) * 0.32;
      setRadius(Math.round(Math.max(mobile ? 155 : 150, Math.min(250, base))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  const close = useCallback(() => closeUsageCampfire(), []);

  if (!open) return null;

  return createPortal(
    <CampfireOverlay
      providers={providers}
      error={error}
      now={now}
      radius={radius}
      sticky={mode === "sticky"}
      onClose={close}
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
  sticky,
  onClose,
}: {
  providers: ProviderUsage[] | null;
  error: string | null;
  now: number;
  radius: number;
  sticky: boolean;
  onClose: () => void;
}) {
  // Prefer available providers first, keep unavailable at the end (dimmed).
  const ordered = useMemo(() => {
    if (!providers) return [];
    return [...providers].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
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
  const positions = useMemo(
    () => arcLayout(ordered.length, radius, mobile),
    [ordered.length, radius, mobile],
  );
  const nextReset = useMemo(() => soonestReset(ordered, now), [ordered, now]);
  const nextLabel = useMemo(() => {
    if (nextReset == null) return null;
    for (const p of ordered) {
      for (const w of p.windows ?? []) {
        if (w.resetsAt === nextReset) return `${p.label} · ${w.label}`;
      }
    }
    return null;
  }, [ordered, nextReset]);

  // Campfire sits lower on phones so the arc of chips has clear air above it.
  const stageCenterY = mobile ? "62%" : "54%";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Agent usage"
      className="fixed inset-0 z-[180] flex items-center justify-center"
      // Sticky: backdrop click closes. Peek (keyboard hold): ignore clicks so
      // release-to-hide stays the only path and we don't steal focus mid-hold.
      onClick={sticky ? onClose : undefined}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/70 backdrop-blur-md transition-opacity duration-200",
          "animate-in fade-in-0",
        )}
      />

      {/* Stage */}
      <div
        className="relative z-10 flex h-[min(92dvh,720px)] w-full max-w-3xl items-center justify-center px-2 sm:px-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Campfire center */}
        <div
          className="pointer-events-none absolute left-1/2 z-0 -translate-x-1/2 -translate-y-1/2"
          style={{ top: stageCenterY }}
        >
          <div
            className="absolute left-1/2 top-1/2 size-48 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-90 sm:size-56 md:size-72"
            style={{
              background:
                "radial-gradient(circle, rgba(251,146,60,0.42) 0%, rgba(249,115,22,0.18) 38%, rgba(239,68,68,0.06) 58%, transparent 72%)",
              animation: "lfg-campfire-pulse 2.4s ease-in-out infinite",
            }}
          />
          <div
            className="absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full sm:size-28 md:size-36"
            style={{
              background:
                "radial-gradient(circle, rgba(253,186,116,0.55) 0%, rgba(251,146,60,0.22) 45%, transparent 70%)",
              animation: "lfg-campfire-pulse 1.6s ease-in-out infinite reverse",
            }}
          />
        </div>

        <div
          className="absolute left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 text-center"
          style={{ top: stageCenterY }}
        >
          <div className="flex items-center gap-1.5 text-orange-300/90">
            <Flame className="size-4 animate-pulse" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]">
              Next restore
            </span>
          </div>
          <div
            className="font-semibold tabular-nums tracking-tight text-white"
            style={{ fontSize: "clamp(2rem, 7vw, 3.25rem)", lineHeight: 1.05 }}
          >
            {providers == null && !error
              ? "…"
              : nextReset
                ? formatCountdown(nextReset, now)
                : "—"}
          </div>
          <p className="max-w-[16rem] text-[12px] text-white/55">
            {error
              ? error
              : nextLabel
                ? nextLabel
                : providers == null
                  ? "Loading usage…"
                  : "No upcoming resets reported"}
          </p>
          <p className="mt-1 text-[10px] text-white/35">
            {sticky ? "Tap outside to close · Esc" : "Release U to hide · Esc"}
          </p>
        </div>

        {/* Agents on the arc */}
        {ordered.map((p, i) => {
          const pos = positions[i] ?? { x: 0, y: 0 };
          const headline = headlineWindow(p);
          const maxPct = headline?.pct ?? maxUsagePct(p);
          const windows = p.windows ?? [];
          // Raise center-of-arc cards above the side ones so overlaps read cleanly.
          const arcT = ordered.length <= 1 ? 0.5 : i / (ordered.length - 1);
          const z = 30 + Math.round((1 - Math.abs(arcT - 0.5) * 2) * 20);
          const style: CSSProperties = {
            left: `calc(50% + ${pos.x}px)`,
            top: `calc(${stageCenterY} + ${pos.y}px)`,
            transform: "translate(-50%, -50%)",
            animationDelay: `${i * 40}ms`,
            zIndex: z,
          };
          return (
            <div
              key={p.kind}
              className={cn(
                // Mobile: tight chip. Desktop: full detail card.
                "absolute select-none w-[4.35rem] sm:w-[7rem]",
                "animate-in fade-in-0 zoom-in-95 duration-200",
                !p.available && "opacity-45",
              )}
              style={style}
            >
              {/* Mobile chip */}
              <div
                className={cn(
                  "flex flex-col items-center gap-0.5 rounded-2xl border border-white/12",
                  "bg-black/70 px-1 py-1.5 shadow-lg shadow-black/50 backdrop-blur-xl",
                  "sm:hidden",
                )}
              >
                <div className="relative">
                  {windows.length ? (
                    <MiniRings windows={windows} size={30} />
                  ) : (
                    <div className="flex size-7 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10" />
                  )}
                  <span className="absolute inset-0 flex items-center justify-center">
                    <img
                      src={agentIconSrc(p.kind)}
                      alt=""
                      className="size-3 rounded-[2px]"
                    />
                  </span>
                </div>
                <div className="w-full truncate text-center text-[9px] font-medium text-white/90">
                  {p.label}
                </div>
                {p.available && maxPct != null ? (
                  <div className={cn("text-[12px] font-semibold tabular-nums", pctTone(maxPct))}>
                    {Math.round(maxPct)}%
                  </div>
                ) : (
                  <div className="text-[9px] text-white/35">—</div>
                )}
              </div>

              {/* Desktop card */}
              <div
                className={cn(
                  "hidden flex-col items-center gap-1 rounded-2xl border border-white/10 sm:flex",
                  "bg-black/55 px-2 py-2 shadow-lg shadow-black/40 backdrop-blur-xl",
                )}
              >
                <div className="relative">
                  {windows.length ? (
                    <MiniRings windows={windows} size={40} />
                  ) : (
                    <div className="flex size-10 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10" />
                  )}
                  <span className="absolute inset-0 flex items-center justify-center">
                    <img
                      src={agentIconSrc(p.kind)}
                      alt=""
                      className="size-4 rounded-[3px]"
                    />
                  </span>
                </div>
                <div className="w-full min-w-0 text-center">
                  <div className="truncate text-[11px] font-medium text-white/90">
                    {p.label}
                  </div>
                  {p.plan ? (
                    <div className="truncate text-[9px] uppercase tracking-wide text-white/40">
                      {p.plan}
                    </div>
                  ) : null}
                </div>
                {p.available && headline ? (
                  <div className="w-full space-y-0.5 text-center">
                    <div
                      className={cn(
                        "text-sm font-semibold tabular-nums",
                        pctTone(maxPct),
                      )}
                    >
                      {maxPct == null ? "—" : `${Math.round(maxPct)}%`}
                    </div>
                    <div className="text-[10px] leading-tight text-white/45">
                      {headline.label}
                      {headline.resetsAt ? (
                        <>
                          <br />
                          {formatResetShort(headline.resetsAt, now)}
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="line-clamp-2 px-0.5 text-center text-[10px] leading-snug text-white/40">
                    {p.note ?? "No data"}
                  </div>
                )}
                {p.available && windows.length > 1 ? (
                  <div className="w-full space-y-0.5 border-t border-white/10 pt-1">
                    {windows.slice(0, 3).map((w, wi) => (
                      <div
                        key={w.label}
                        className="flex items-center justify-between gap-1 text-[9px] text-white/40"
                      >
                        <span className="flex min-w-0 items-center gap-1 truncate">
                          <span
                            className="size-1.5 shrink-0 rounded-full"
                            style={{
                              backgroundColor: RING_COLORS[wi % RING_COLORS.length],
                            }}
                          />
                          <span className="truncate">{w.label}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-white/55">
                          {w.pct == null ? "—" : `${Math.round(w.pct)}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}

        {providers != null && ordered.length === 0 && !error ? (
          <p className="absolute bottom-8 left-1/2 z-20 -translate-x-1/2 text-sm text-white/50">
            No usage providers reported
          </p>
        ) : null}
      </div>

      {/* Local keyframes — self-contained, no index.css edit required */}
      <style>{`
        @keyframes lfg-campfire-pulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
          50% { transform: translate(-50%, -50%) scale(1.08); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ── long-press helper for the activity ring button ──────────────────────────

const RING_LONG_PRESS_MS = 420;

/**
 * Pointer handlers that open the sticky campfire on long-press without
 * suppressing short taps (which still open the per-provider dropdown).
 *
 * Returns props to spread onto the ring trigger button, plus `suppressClick`
 * which is true after a long-press so the following synthetic click is ignored.
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
      // If long-press already opened the overlay, swallow the click that follows.
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
