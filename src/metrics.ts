// Rolling host-metrics sampler for the settings Performance panel.
//
// Why PSI and not just "percent used": a box can sit at 90% memory with zero
// stall and be perfectly healthy, while 70% with rising pressure is already
// dying. PSI (/proc/pressure/*) measures the share of wall-clock time tasks
// spent STALLED waiting for a resource, so it rises while headroom still looks
// fine — which is the lead time a warning needs. On the 2026-08-02 outage the
// host logged memory-pressure events for ~40 minutes before it went down.
//
// Everything here is best-effort and Linux-only: on a kernel without PSI (or
// on macOS) the readers return null and the UI degrades to "unavailable"
// rather than breaking the panel.

import { readFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";

export type PressureKind = "cpu" | "memory" | "io";

// `some` = at least one task stalled; `full` = every task stalled (never
// reported for cpu). avg10 is the 10-second window — the responsive one.
export type PressureReading = { some10: number; full10: number } | null;

export type MetricSample = {
  t: number;
  cpuPct: number; // load1 normalised by core count, clamped to 100
  memPct: number; // host RAM in use
  rxBps: number; // network bytes/sec in
  txBps: number; // network bytes/sec out
  psiCpu: number | null; // "some avg10"
  psiMem: number | null;
  psiIo: number | null;
};

const HISTORY_MAX = 120; // 120 samples x 5s = 10 minutes
const SAMPLE_MS = 5_000;

const history: MetricSample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let lastNet: { t: number; rx: number; tx: number } | null = null;

// Parse one /proc/pressure/<kind> file. Format:
//   some avg10=0.00 avg60=0.00 avg300=0.00 total=0
//   full avg10=0.00 ...
async function readPressure(kind: PressureKind): Promise<PressureReading> {
  try {
    const raw = await readFile(`/proc/pressure/${kind}`, "utf8");
    const pick = (line: string | undefined): number => {
      if (!line) return 0;
      const m = /avg10=([0-9.]+)/.exec(line);
      return m ? Number(m[1]) : 0;
    };
    const lines = raw.split("\n");
    return {
      some10: pick(lines.find((l) => l.startsWith("some"))),
      full10: pick(lines.find((l) => l.startsWith("full"))),
    };
  } catch {
    return null;
  }
}

export async function readAllPressure(): Promise<Record<PressureKind, PressureReading>> {
  const [cpu, memory, io] = await Promise.all([
    readPressure("cpu"),
    readPressure("memory"),
    readPressure("io"),
  ]);
  return { cpu, memory, io };
}

// Sum rx/tx across real interfaces. Skips loopback and virtual/container
// bridges so the number reflects actual off-box traffic.
const SKIP_IFACE = /^(lo|docker|br-|veth|virbr|tailscale)/;

async function readNetTotals(): Promise<{ rx: number; tx: number } | null> {
  try {
    const raw = await readFile("/proc/net/dev", "utf8");
    let rx = 0;
    let tx = 0;
    for (const line of raw.split("\n").slice(2)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const name = line.slice(0, idx).trim();
      if (!name || SKIP_IFACE.test(name)) continue;
      const f = line.slice(idx + 1).trim().split(/\s+/);
      rx += Number(f[0]) || 0;
      tx += Number(f[8]) || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

async function sample(): Promise<void> {
  const now = Date.now();
  const total = totalmem();
  const free = freemem();
  const cores = Math.max(1, cpus().length);
  const [load1] = loadavg();

  let rxBps = 0;
  let txBps = 0;
  const net = await readNetTotals();
  if (net) {
    if (lastNet) {
      const dt = (now - lastNet.t) / 1000;
      if (dt > 0) {
        // Guard against counter resets (interface flap / migration).
        rxBps = Math.max(0, (net.rx - lastNet.rx) / dt);
        txBps = Math.max(0, (net.tx - lastNet.tx) / dt);
      }
    }
    lastNet = { t: now, rx: net.rx, tx: net.tx };
  }

  const psi = await readAllPressure();

  history.push({
    t: now,
    cpuPct: Math.min(100, Math.round((load1 / cores) * 100)),
    memPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
    rxBps: Math.round(rxBps),
    txBps: Math.round(txBps),
    psiCpu: psi.cpu ? psi.cpu.some10 : null,
    psiMem: psi.memory ? psi.memory.some10 : null,
    psiIo: psi.io ? psi.io.some10 : null,
  });
  if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
}

export function startMetricsSampler(): void {
  if (timer) return;
  void sample(); // prime immediately so the panel isn't empty on first load
  timer = setInterval(() => void sample(), SAMPLE_MS);
  // Never hold the process open for a metrics tick.
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function stopMetricsSampler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function getMetricsHistory(): MetricSample[] {
  return history.slice();
}

export function latestSample(): MetricSample | null {
  return history.length ? history[history.length - 1]! : null;
}
