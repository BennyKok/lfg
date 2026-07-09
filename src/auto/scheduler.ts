// In-process cron scheduler. lfg-serve runs persistently, so we tick once a
// minute and fire any enabled auto agent that is due. Two things that bit us:
//   1. Cron is interpreted in the user's global settings timezone, NOT the
//      box's UTC — so "0 11 * * *" means 11:00 in that configured zone.
//   2. Catch-up: we fire the MOST RECENT scheduled instant in the last ~25h if
//      the agent hasn't run since it. So a missed minute (service restart, box
//      asleep) still runs that day instead of silently skipping.
// Runs are processed sequentially — the AI-SDK runner uses a global
// process.chdir, so concurrent runs would race on the working directory.

import { listAutoAgents, setLastRun } from "./store.ts";
import { runAutoAgent } from "./runner.ts";
import { getGlobalSettingsSync } from "../settings.ts";

const DOW: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

// Wall-clock fields of `d` in timezone `tz`.
function zonedParts(d: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    minute: parseInt(parts.minute as string, 10),
    hour: parseInt(parts.hour as string, 10),
    dom: parseInt(parts.day as string, 10),
    month: parseInt(parts.month as string, 10),
    dow: DOW[parts.weekday as string] ?? 0,
  };
}

function fieldMatch(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10) || 1;
      if (range === "*") {
        if (value % step === 0) return true;
        continue;
      }
      const [lo, hi] = range.split("-").map((n) => parseInt(n, 10));
      if (!Number.isNaN(lo)) {
        const top = Number.isNaN(hi) ? lo : hi;
        for (let v = lo; v <= top; v += step) if (v === value) return true;
      }
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => parseInt(n, 10));
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b)
        return true;
      continue;
    }
    if (parseInt(part, 10) === value) return true;
  }
  return false;
}

// Standard 5-field cron, evaluated in TZ: minute hour day-of-month month day-of-week.
export function cronMatches(expr: string, d: Date, tz: string = getGlobalSettingsSync().timeZone): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const p = zonedParts(d, tz);
  return (
    fieldMatch(f[0], p.minute) &&
    fieldMatch(f[1], p.hour) &&
    fieldMatch(f[2], p.dom) &&
    fieldMatch(f[3], p.month) &&
    fieldMatch(f[4], p.dow)
  );
}

// The most recent minute <= now (within lookback) at which the cron matched,
// or null if it hasn't matched in the window. Used for catch-up.
function mostRecentDue(expr: string, now: Date, tz: string, lookbackMin = 1500): number | null {
  const base = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let i = 0; i <= lookbackMin; i++) {
    const t = base - i * 60_000;
    if (cronMatches(expr, new Date(t), tz)) return t;
  }
  return null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startAutoScheduler(onLog: (s: string) => void = () => {}): void {
  if (timer) return;

  const tick = async () => {
    if (ticking) return; // a long catch-up batch can outlast the 60s interval
    ticking = true;
    try {
      const now = new Date();
      const tz = getGlobalSettingsSync().timeZone;
      let agents;
      try {
        agents = await listAutoAgents();
      } catch {
        return;
      }
      for (const a of agents) {
        if (!a.enabled || !a.schedule) continue;
        const due = mostRecentDue(a.schedule, now, tz);
        if (due === null) continue;
        if (a.lastRunAt && a.lastRunAt >= due) continue; // already ran for this instant
        // Stamp first so a crash mid-run doesn't loop-retry the same instant.
        await setLastRun(a.id, now.getTime()).catch(() => {});
        onLog(`[auto-sched] firing ${a.id} (due ${new Date(due).toISOString()})`);
        try {
          await runAutoAgent(a, onLog); // sequential — chdir is process-global
        } catch (e) {
          onLog(`[auto-sched] ${a.id} failed: ${e}`);
        }
      }
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(() => void tick(), 60_000);
  // Fire an initial tick shortly after boot so a restart near (or past) a
  // scheduled time catches up promptly instead of waiting up to 60s.
  setTimeout(() => void tick(), 3_000);
  onLog(`[auto-sched] started (tz=${getGlobalSettingsSync().timeZone}, 60s tick + catch-up)`);
}
