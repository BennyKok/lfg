import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./config.ts";

const LOG_DIR = join(PATHS.data, "logs");
const MAX_QUEUE = 2_000;
const RETENTION_DAYS = Math.max(1, Number(process.env.LFG_TRACE_RETENTION_DAYS ?? 7) || 7);
const TRANSCRIPT_PAGE_SAMPLE_RATE = Math.max(
  1,
  Number(process.env.LFG_TRACE_TRANSCRIPT_PAGE_SAMPLE_RATE ?? 100) || 100,
);

let queue: string[] = [];
let flushing = false;
let transcriptPageCount = 0;
let cleanupStarted = false;

function logPath(): string {
  return join(LOG_DIR, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function keepEvent(event: string, fields: Record<string, unknown>): boolean {
  if (event !== "transcript_page" || process.env.LFG_TRACE_TRANSCRIPT_PAGES === "1") return true;
  const durationMs = typeof fields.durationMs === "number" ? fields.durationMs : 0;
  if (durationMs >= 250) return true;
  transcriptPageCount++;
  return transcriptPageCount % TRANSCRIPT_PAGE_SAMPLE_RATE === 0;
}

async function cleanOldLogs(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of await readdir(LOG_DIR)) {
      const match = /^trace-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!match) continue;
      const day = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isFinite(day) && day < cutoff) await unlink(join(LOG_DIR, name)).catch(() => {});
    }
  } catch {
    // Retention is best-effort and must never affect request handling.
  }
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.length > 8_000 ? `${value.slice(0, 8_000)}...` : value;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(scrub);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrub(item);
  return out;
}

async function flush(): Promise<void> {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(logPath(), batch.join(""));
  } catch {
    // Diagnostics must not affect the app path being measured.
  } finally {
    flushing = false;
    if (queue.length) void flush();
  }
}

export function traceLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    if (!keepEvent(event, fields)) return;
    void cleanOldLogs();
    if (queue.length >= MAX_QUEUE) queue = queue.slice(Math.floor(MAX_QUEUE / 2));
    const safeFields = scrub(fields) as Record<string, unknown>;
    queue.push(
      `${JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        monoMs: Math.round(performance.now() * 1000) / 1000,
        event,
        ...safeFields,
      })}\n`,
    );
    void flush();
  } catch {
    // Ignore logging failures.
  }
}

export function traceLogPathForToday(): string {
  return logPath();
}
