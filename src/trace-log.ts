import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "./config.ts";

const LOG_DIR = join(PATHS.data, "logs");
const MAX_QUEUE = 2_000;

let queue: string[] = [];
let flushing = false;

function logPath(): string {
  return join(LOG_DIR, `trace-${new Date().toISOString().slice(0, 10)}.jsonl`);
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
