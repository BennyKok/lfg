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
import { omgAssetUrl } from "@/lib/omg-client";
import {
  useUsageFeed,
  type ProviderUsage,
  type UsageProviderRef,
  type UsageWindow,
} from "@/lib/usage";

// ── public types (mirror /api/usage) ────────────────────────────────────────

export type { ProviderUsage, UsageProviderRef, UsageWindow };

/** What one arc slot renders: the source, plus its usage once that source lands. */
type ArcEntry = UsageProviderRef & { usage: ProviderUsage | null };

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
  if (kind === "codex" || kind === "codex-aisdk") return omgAssetUrl(`/agent-codex.svg${v}`);
  if (kind === "grok") return omgAssetUrl(`/agent-grok.svg${v}`);
  if (kind === "cursor") return omgAssetUrl(`/agent-cursor.svg${v}`);
  if (kind === "hermes") return omgAssetUrl(`/agent-hermes.svg${v}`);
  if (kind === "opencode") return omgAssetUrl(`/agent-opencode.svg${v}`);
  if (kind === "pi") return omgAssetUrl(`/agent-pi.svg${v}`);
  if (kind === "copilot") return omgAssetUrl(`/agent-copilot.svg${v}`);
  return omgAssetUrl(`/agent-claude.svg${v}`);
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

/** A source has something to draw only once it reports at least one window. */
function plottableUsage(p: ProviderUsage | null): boolean {
  return Boolean(p?.available && (p.windows?.length ?? 0) > 0);
}

/**
 * Does the node's own label already end in its account number? Default account
 * labels do ("Claude 1"), and the arc prints that label right under the icon —
 * so stamping the badge as well renders the number twice, "1" over "Claude 1".
 * A renamed account ("Work") still needs the badge to say which login it is.
 */
function labelStatesNumber(label: string, accountNumber: number): boolean {
  return new RegExp(`(^|\\s)${accountNumber}$`).test(label.trim());
}

/**
 * An arc node is about 80px wide, so a caption only has room for two or three
 * words — the full note stays as the hover title.
 */
function shortNote(note: string | null | undefined): string {
  const n = note ?? "";
  if (/401|403|sign-?in expired/i.test(n)) return "sign-in expired";
  if (/429|rate limit/i.test(n)) return "rate limited";
  if (/not signed in/i.test(n)) return "not signed in";
  if (/no longer on this box/i.test(n)) return "account missing";
  return "usage unavailable";
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

/**
 * How big one agent node may be, given how many share the arc. Multi-account
 * Claude turns "four or five agents" into seven or eight, and at the original
 * fixed size a phone-width arc ran its labels straight through each other.
 */
function nodeMetrics(count: number, mobile: boolean) {
  const tier = count >= 8 ? 2 : count >= 6 ? 1 : 0;
  return mobile
    ? [
        { width: 73.6, logo: 46, ring: 15, pct: 14 },
        { width: 56, logo: 36, ring: 13, pct: 12.5 },
        { width: 48, logo: 30, ring: 12, pct: 11.5 },
      ][tier]
    : [
        { width: 105.6, logo: 64, ring: 18, pct: 18 },
        { width: 88, logo: 54, ring: 16, pct: 16 },
        { width: 76, logo: 44, ring: 14, pct: 14 },
      ][tier];
}

/** Half a node's width plus breathing room — how close the arc may run to the edge. */
function arcNodeHalfWidth(count: number, mobile: boolean): number {
  return nodeMetrics(count, mobile).width / 2 + (mobile ? 3 : 5);
}

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
  const startX = Math.cos(start) * radius * xScale;
  const endX = Math.cos(end) * radius * xScale;
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0.5 : i / (count - 1);
    // Spaced evenly along x, then lifted onto the same ellipse — stepping by
    // equal *angle* crowds both ends of an ellipse together, and horizontal
    // spacing is what decides whether two labels collide.
    const x = startX + (endX - startX) * t;
    const nx = Math.max(-1, Math.min(1, x / (radius * xScale)));
    return {
      x,
      // acos gives the upper half of the ellipse; CSS +y is down, so negate.
      y: -Math.sin(Math.acos(nx)) * radius * yScale + yLift,
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
  /**
   * Clicking an agent picks it in the composer and opens it. Claude reports one
   * entry per connected account, so the account rides along with the kind.
   */
  onSelectAgent?: (kind: string, accountId?: string) => void;
} = {}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [radius, setRadius] = useState(160);
  // Each source is fetched on its own, so Claude 1's numbers land without
  // waiting on Grok's billing round-trip or a walk of the Codex sessions tree.
  const feed = useUsageFeed({ enabled: open, refreshMs: 30_000 });

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

  // Live countdown tick.
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // Responsive arc radius. A crowded arc uses smaller nodes, which lets the
  // ends run closer to the screen edge — so the count feeds the measurement.
  const slotCount = feed.refs?.length ?? 4;
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const mobile = w < 768;
      const halfNode = arcNodeHalfWidth(slotCount, mobile);
      const xScale = mobile ? ARC_X_SCALE_MOBILE : ARC_X_SCALE_DESKTOP;
      // Widest the arc may be before the end nodes collide with the edge.
      const maxByWidth = (w / 2 - halfNode - 8) / xScale;
      const base = Math.min(maxByWidth, mobile ? h * 0.26 : Math.min(w, h) * 0.3);
      setRadius(Math.round(Math.max(mobile ? 118 : 155, Math.min(245, base))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, slotCount]);

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
      refs={feed.refs}
      providers={feed.providers}
      loading={feed.loading}
      error={feed.error}
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
  refs,
  providers,
  loading: feedLoading,
  error,
  now,
  radius,
  onClose,
  onSelectAgent,
}: {
  refs: UsageProviderRef[] | null;
  providers: ProviderUsage[];
  loading: boolean;
  error: string | null;
  now: number;
  radius: number;
  onClose: () => void;
  onSelectAgent?: (kind: string, accountId?: string) => void;
}) {
  // Slots come from the source directory, which arrives before any usage does —
  // so the arc lays out once, at the right size, and each agent fills in when
  // its own request lands rather than after the slowest one.
  //
  // Once everything has answered we drop the sources with nothing to plot: an
  // unconfigured provider has nothing to show, and a row of greyed-out
  // placeholders was the noisiest thing on the arc — it read as "broken"
  // rather than "not set up".
  //
  // A connected account is the exception. It IS set up, so silently dropping it
  // when its usage read fails (expired token, network blip) makes the account
  // look like it doesn't exist — you count the nodes, come up short, and have no
  // way to tell whether it's missing or just unreadable. Those keep their slot
  // and say what went wrong.
  const ordered = useMemo<ArcEntry[]>(() => {
    if (!refs) return [];
    const byId = new Map(providers.map((p) => [p.id, p]));
    const keep = (entry: ArcEntry) =>
      plottableUsage(entry.usage) || entry.accountId != null;
    const entries = refs
      .map((ref) => ({ ...ref, usage: byId.get(ref.id) ?? null }))
      // Claude accounts sort together and in number order; everything else by name.
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          (a.accountNumber ?? 0) - (b.accountNumber ?? 0) ||
          a.label.localeCompare(b.label),
      );
    return feedLoading
      ? entries.filter((entry) => !entry.usage || keep(entry as ArcEntry))
      : entries.filter(keep);
  }, [refs, providers, feedLoading]);

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

  // Provider families showing more than one node (i.e. multiple Claude
  // accounts), which are the ones whose icons need a number to tell apart.
  const numberedKinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of ordered) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([kind]) => kind));
  }, [ordered]);

  // Nothing to lay out until the directory arrives; after that the slot count is
  // final, so an agent resolving never shifts its neighbours.
  const loading = refs == null && !error;
  const nodeCount = loading ? 4 : ordered.length;
  const positions = useMemo(
    () => arcLayout(nodeCount, radius, mobile),
    [nodeCount, radius, mobile],
  );

  // Hovering (or tapping) an agent retargets the centre readout to that agent.
  // Keyed by source id, not kind — two Claude accounts are two separate nodes.
  const [focusId, setFocusId] = useState<string | null>(null);
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
  const focusedEntry = useMemo(
    () => ordered.find((entry) => entry.id === focusId) ?? null,
    [ordered, focusId],
  );
  const focused = focusedEntry?.usage ?? null;
  // The hero reads whatever has landed so far — a Claude account that answered
  // first shouldn't be excluded from "next restore" because Grok is still out.
  const heroScope = useMemo<ProviderUsage[]>(
    () =>
      focused
        ? [focused]
        : ordered
            .map((entry) => entry.usage)
            .filter((usage): usage is ProviderUsage => usage != null),
    [focused, ordered],
  );
  const heroReset = useMemo(() => soonestReset(heroScope, now), [heroScope, now]);
  const heroLabel = useMemo(() => {
    if (heroReset == null) return null;
    for (const p of heroScope) {
      for (const w of p.windows ?? []) {
        if (w.resetsAt === heroReset) return `${p.label} · ${w.label}`;
      }
    }
    return null;
  }, [heroScope, heroReset]);

  // A focused provider can report more than one window (Codex: Session +
  // Weekly, Claude: 5 hr + 7 day). Keep the soonest reset in the hero, then
  // retain every other upcoming reset as a compact companion readout instead
  // of making the user guess when the secondary window comes back.
  const otherFocusedResets = useMemo(
    () =>
      focused && heroReset != null
        ? (focused.windows ?? [])
            .filter(
              (window) =>
                window.resetsAt != null &&
                window.resetsAt > now &&
                window.resetsAt !== heroReset,
            )
            .sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0))
        : [],
    [focused, heroReset, now],
  );

  // Not every provider reports a reset time. Rather than answer a hover with
  // "No upcoming resets reported", fall back to what that agent DOES know —
  // how much of its window is spent — and relabel the eyebrow to match.
  const focusHeadline = focused ? headlineWindow(focused) : null;
  const showUsed =
    focused != null && heroReset == null && focusHeadline?.pct != null;

  const stageCenterY = mobile ? "60%" : "55%";
  const metrics = nodeMetrics(nodeCount, mobile);
  const logoSize = metrics.logo;
  const ringSize = metrics.ring;
  const skeletonSize = metrics.logo;

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
            style={{ color: focusedEntry ? TONE.label : TONE.soft }}
          >
            {error
              ? error
              : loading
                ? "Reading agent limits…"
                : showUsed && focused && focusHeadline
                  ? `${focused.label} · ${focusHeadline.label}`
                  : heroLabel
                    ? heroLabel
                    : focusedEntry && !focused
                      ? `Reading ${focusedEntry.label}…`
                      : ordered.length
                        ? "No upcoming resets reported"
                        : "No agents reporting usage"}
          </p>
          {otherFocusedResets.length ? (
            <div
              className="mt-0.5 flex flex-col items-center gap-0.5 text-[10px] tabular-nums sm:text-[11px]"
              style={{ color: TONE.soft }}
              aria-label="Other upcoming resets"
            >
              {otherFocusedResets.map((window) => (
                <span key={`${window.label}-${window.resetsAt}`}>
                  <span style={{ color: TONE.label }}>{window.label}</span>
                  {" restores "}
                  {formatResetShort(window.resetsAt, now)}
                </span>
              ))}
            </div>
          ) : null}
          <p className="mt-0.5 text-[10px]" style={{ color: TONE.faint }}>
            {canHover
              ? onSelectAgent
                ? "Click an agent to start a session · Shift or Esc to close"
                : "Shift to close · Esc"
              : focusedEntry && onSelectAgent
                ? `Tap ${focusedEntry.label} again to start a session`
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
        {ordered.map((entry, i) => {
          const p = entry.usage;
          const pos = positions[i] ?? { x: 0, y: 0 };
          const headline = p ? headlineWindow(p) : null;
          const maxPct = headline?.pct ?? (p ? maxUsagePct(p) : null);
          const isFocused = focusId === entry.id;
          const dimmed = focusId != null && !isFocused;
          // This source hasn't answered yet — the slot is already in its final
          // place, so it spins in place rather than pushing anything around.
          const resolving = p == null;
          // Answered, but with nothing to plot — only accounts get to stay in
          // this state (see `keep` above), so it always means "couldn't read
          // this account's usage", not "not configured".
          const unreadable = !resolving && !plottableUsage(p);
          return (
            <button
              key={entry.id}
              type="button"
              aria-label={`${entry.label} usage${maxPct == null ? "" : `, ${Math.round(maxPct)} percent`}${onSelectAgent ? " — start a session" : ""}`}
              // Mouse drives focus by hover. Touch can't hover — and a tap emits
              // its own enter/leave pair that would immediately undo the focus —
              // so touch/pen toggle on pointerdown instead.
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") setFocusId(entry.id);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") {
                  setFocusId((c) => (c === entry.id ? null : c));
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
                // Armed state is tracked separately from `focusId`: tapping
                // also focuses the button, so onFocus would have already marked
                // it focused by the time this runs, and the first tap would look
                // like the second.
                if (!canHover && armedRef.current !== entry.id) {
                  armedRef.current = entry.id;
                  setFocusId(entry.id);
                  return;
                }
                armedRef.current = null;
                onSelectAgent(entry.kind, entry.accountId);
                onClose();
              }}
              onFocus={() => setFocusId(entry.id)}
              onBlur={() => setFocusId((c) => (c === entry.id ? null : c))}
              className={cn(
                "lfg-campfire-arc-item absolute z-20 flex select-none flex-col items-center gap-1 rounded-2xl px-1 py-1.5",
                onSelectAgent ? "cursor-pointer" : "cursor-default",
                // left/top animate too: when the last source lands, any slot
                // with nothing to plot drops out and the arc glides closed
                // instead of snapping.
                "outline-none transition-[opacity,transform,left,top] duration-300 ease-out",
                "focus-visible:ring-2 focus-visible:ring-orange-300/50",
              )}
              style={
                {
                  "--lfg-arc-x": `${pos.x}px`,
                  "--lfg-arc-y": `${pos.y}px`,
                  "--lfg-arc-scale": isFocused ? 1.07 : 1,
                  width: metrics.width,
                  left: `calc(50% + ${pos.x}px)`,
                  top: `calc(${stageCenterY} + ${pos.y}px)`,
                  transform:
                    "translate(-50%, -50%) scale(var(--lfg-arc-scale))",
                  // Emphasis: the hovered agent stays lit, the rest recede.
                  opacity: dimmed ? 0.42 : unreadable ? 0.62 : 1,
                  animationDelay: `${i * 40}ms`,
                } as CSSProperties
              }
            >
              {/* The logo leads — it's the thing you aim at to start a session. */}
              <span className="relative inline-flex">
                <img
                  src={agentIconSrc(entry.kind)}
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
                {/* Same numbered badge the composer puts on its Claude icons.
                    Only earns its space once two accounts share one mark — and
                    only when the label below isn't already saying the number. */}
                {entry.accountNumber != null &&
                numberedKinds.has(entry.kind) &&
                !labelStatesNumber(entry.label, entry.accountNumber) ? (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 flex size-[1.15em] items-center justify-center rounded-full text-[10px] font-semibold tabular-nums sm:text-[11px]"
                    style={{
                      background: "rgba(24,16,10,0.92)",
                      color: TONE.label,
                      boxShadow: "0 0 0 1.5px rgba(24,16,10,0.92)",
                    }}
                    aria-hidden
                  >
                    {entry.accountNumber}
                  </span>
                ) : null}
              </span>
              <div
                className="w-full truncate text-center text-[10px] font-medium sm:text-[11px]"
                style={{ color: TONE.label }}
              >
                {entry.label}
              </div>
              {/* Compact meter beside its own number — the ring and the digits
                  describe the same window, so they read as one unit. */}
              <div className="flex items-center justify-center gap-1.5">
                {resolving ? (
                  <SpinnerRing size={ringSize} delayMs={i * 120} />
                ) : headline ? (
                  <MiniRings windows={[headline]} size={ringSize} />
                ) : null}
                <span
                  className="font-semibold leading-none tabular-nums"
                  style={{
                    fontSize: metrics.pct,
                    color: pctColor(maxPct),
                  }}
                >
                  {maxPct == null ? "—" : `${Math.round(maxPct)}%`}
                </span>
              </div>
              {/* The window name is the non-colour half of the status cue —
                  or, for an account we couldn't read, the reason why. */}
              {headline ? (
                <div
                  className="w-full truncate text-center text-[9px] leading-tight sm:text-[10px]"
                  style={{ color: TONE.muted }}
                >
                  {headline.label}
                </div>
              ) : unreadable ? (
                <div
                  className="w-full truncate text-center text-[9px] leading-tight sm:text-[10px]"
                  style={{ color: TONE.muted }}
                  title={p?.note ?? undefined}
                >
                  {shortNote(p?.note)}
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
