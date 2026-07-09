import { statSync } from "node:fs";
import type { Session, SessionMsg } from "./sessions.ts";
import { traceLog } from "./trace-log.ts";

export type IndexedTranscriptMatch = {
  sessionId: string;
  path: string;
  role: string;
  kind: SessionMsg["kind"];
  ts: number | null;
  snippet: string;
  offset: number;
};

export type TranscriptIndexCursor = {
  path: string;
  sessionId: string;
  size: number;
  offset: number;
  mtimeMs: number;
  indexedAt: number;
};

type IndexTranscriptResult = {
  indexed: number;
  offset: number;
  size: number;
};

type MessagePageResult = {
  messages: SessionMsg[];
  nextBefore: number | null;
  total: number;
};

type SearchResult = {
  total: number;
  scanned: number;
  truncated: boolean;
  results: IndexedTranscriptMatch[];
};

type SearchAllResult = {
  total: number;
  results: IndexedTranscriptMatch[];
};

type TranscriptIndexWorkerRequest =
  | { id: number; type: "cursor"; path: string }
  | { id: number; type: "delete"; path: string }
  | {
      id: number;
      type: "indexMessages";
      path: string;
      sessionId: string;
      lines: Array<{ offset: number; messages: SessionMsg[] }>;
      cursor?: { size: number; offset: number; mtimeMs: number };
    }
  | { id: number; type: "indexTranscript"; path: string; sessionId: string }
  | {
      id: number;
      type: "messagePage";
      path: string;
      sessionId: string;
      opts?: { before?: number | null; limit?: number };
    }
  | { id: number; type: "search"; path: string; sessionId: string; query: string; opts?: { limit?: number } }
  | { id: number; type: "searchAll"; query: string; opts?: { limit?: number } }
  | { id: number; type: "shutdown" };

type TranscriptIndexWorkerResponse =
  | { id: number; ok: true; result: unknown; cursor?: TranscriptIndexCursor | null }
  | { id: number; ok: false; error: string; code?: string };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  path?: string;
  writeBytes: number;
};

const BACKGROUND_LIMIT = 8;
const MAX_PENDING_WRITE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.LFG_TRANSCRIPT_INDEX_WORKER_QUEUE_BYTES ?? 32 * 1024 * 1024) || 32 * 1024 * 1024,
);
const MAX_PENDING_REQUESTS = Math.max(
  128,
  Number(process.env.LFG_TRANSCRIPT_INDEX_WORKER_PENDING ?? 4_000) || 4_000,
);

let worker: Worker | null = null;
let nextRequestId = 1;
let queuedWriteBytes = 0;
let shuttingDown = false;
let backgroundRunning = false;
let monitorStarted = false;
let monitorRunning = false;

const pending = new Map<number, PendingRequest>();
const cursorCache = new Map<string, TranscriptIndexCursor>();
const cursorFetches = new Set<string>();
const enqueued = new Set<string>();
const imports = new Map<string, Promise<IndexTranscriptResult>>();

function rememberCursor(path: string | undefined, cursor: TranscriptIndexCursor | null | undefined): void {
  if (!path) return;
  if (cursor === null) {
    cursorCache.delete(path);
    return;
  }
  if (cursor) cursorCache.set(path, cursor);
}

function rejectPending(err: Error): void {
  for (const item of pending.values()) {
    queuedWriteBytes = Math.max(0, queuedWriteBytes - item.writeBytes);
    item.reject(err);
  }
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  if (shuttingDown) throw new Error("transcript index worker is shutting down");
  const next = new Worker(new URL("./transcript-index-worker.ts", import.meta.url), { type: "module" });
  (next as { unref?: () => void }).unref?.();
  next.addEventListener("message", (event: MessageEvent<TranscriptIndexWorkerResponse>) => {
    const response = event.data;
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    queuedWriteBytes = Math.max(0, queuedWriteBytes - item.writeBytes);
    if (response.ok) {
      rememberCursor(item.path, response.cursor);
      item.resolve(response.result);
    } else {
      const err = new Error(response.error);
      if (response.code) (err as Error & { code?: string }).code = response.code;
      item.reject(err);
    }
  });
  next.addEventListener("error", (event) => {
    const err = event instanceof ErrorEvent && event.error instanceof Error
      ? event.error
      : new Error("transcript index worker failed");
    traceLog("transcript_index_worker_error", { error: err.message });
    worker = null;
    rejectPending(err);
  });
  worker = next;
  return next;
}

function sendWorker<T>(
  request: { type: TranscriptIndexWorkerRequest["type"]; [key: string]: unknown },
  opts: { path?: string; writeBytes?: number } = {},
): Promise<T> {
  if (shuttingDown && request.type !== "shutdown") {
    return Promise.reject(new Error("transcript index worker is shutting down"));
  }
  const id = nextRequestId++;
  const writeBytes = opts.writeBytes ?? 0;
  queuedWriteBytes += writeBytes;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      path: opts.path,
      writeBytes,
    });
    try {
      ensureWorker().postMessage({ id, ...request } as TranscriptIndexWorkerRequest);
    } catch (err) {
      pending.delete(id);
      queuedWriteBytes = Math.max(0, queuedWriteBytes - writeBytes);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function estimateLinesBytes(lines: Array<{ offset: number; messages: SessionMsg[] }>): number {
  let bytes = 64;
  for (const line of lines) {
    bytes += 32;
    for (const message of line.messages) bytes += 128 + message.text.length * 2;
  }
  return bytes;
}

function countIndexableMessages(lines: Array<{ offset: number; messages: SessionMsg[] }>): number {
  let indexed = 0;
  for (const line of lines) {
    for (const message of line.messages) if (message.text.trim()) indexed++;
  }
  return indexed;
}

function requestCursor(path: string): void {
  if (cursorCache.has(path) || cursorFetches.has(path) || shuttingDown) return;
  cursorFetches.add(path);
  void sendWorker<TranscriptIndexCursor | null>({ type: "cursor", path }, { path })
    .then((cursor) => rememberCursor(path, cursor))
    .catch((err) => {
      traceLog("transcript_index_cursor_error", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      cursorFetches.delete(path);
    });
}

function shouldCoalesceWrite(path: string, sessionId: string, writeBytes: number): boolean {
  if (queuedWriteBytes + writeBytes <= MAX_PENDING_WRITE_BYTES && pending.size < MAX_PENDING_REQUESTS) {
    return false;
  }
  traceLog("transcript_index_backpressure", {
    sessionId,
    path,
    pending: pending.size,
    queuedWriteBytes,
    coalescedBytes: writeBytes,
  });
  enqueueTranscriptIndex(path, sessionId);
  return true;
}

export function transcriptCursorFor(path: string): TranscriptIndexCursor | null {
  const cursor = cursorCache.get(path) ?? null;
  if (!cursor) requestCursor(path);
  return cursor;
}

export function transcriptIndexCurrent(path: string): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  const cursor = transcriptCursorFor(path);
  return !!cursor && cursor.offset === st.size && cursor.size === st.size && cursor.mtimeMs === st.mtimeMs;
}

export function deleteTranscriptIndexForPath(path: string): void {
  cursorCache.delete(path);
  void sendWorker<null>({ type: "delete", path }, { path }).catch((err) => {
    traceLog("transcript_index_delete_error", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function indexTranscriptMessages(
  path: string,
  sessionId: string,
  lines: Array<{ offset: number; messages: SessionMsg[] }>,
  cursor?: { size: number; offset: number; mtimeMs: number },
): number {
  const indexed = countIndexableMessages(lines);
  if (!indexed && !cursor) return 0;
  const writeBytes = estimateLinesBytes(lines);
  if (shouldCoalesceWrite(path, sessionId, writeBytes)) return indexed;
  void sendWorker<{ indexed: number }>(
    { type: "indexMessages", path, sessionId, lines, cursor },
    { path, writeBytes },
  ).catch((err) => {
    traceLog("transcript_index_live_error", {
      sessionId,
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return indexed;
}

export async function indexTranscript(path: string, sessionId: string): Promise<IndexTranscriptResult> {
  const existing = imports.get(path);
  if (existing) return existing;
  const pendingImport = sendWorker<IndexTranscriptResult>(
    { type: "indexTranscript", path, sessionId },
    { path },
  ).finally(() => {
    imports.delete(path);
  });
  imports.set(path, pendingImport);
  return pendingImport;
}

export function enqueueTranscriptIndex(path: string, sessionId: string): void {
  if (enqueued.has(path)) return;
  enqueued.add(path);
  traceLog("transcript_index_enqueue", { sessionId, path });
  const timer = setTimeout(() => {
    void indexTranscript(path, sessionId)
      .catch((err) => {
        traceLog("transcript_index_error", {
          sessionId,
          path,
          error: err instanceof Error ? err.message : String(err),
        });
        console.warn(
          `[transcript-index] lazy index failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        enqueued.delete(path);
      });
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}

export async function indexedMessagePage(
  path: string,
  sessionId: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<MessagePageResult> {
  return sendWorker<MessagePageResult>({ type: "messagePage", path, sessionId, opts }, { path });
}

export async function indexedRecentMessages(
  path: string,
  sessionId: string,
  limit = 40,
): Promise<SessionMsg[]> {
  const page = await indexedMessagePage(path, sessionId, { limit });
  return page.messages;
}

export async function searchTranscriptIndex(
  path: string,
  sessionId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchResult> {
  return sendWorker<SearchResult>({ type: "search", path, sessionId, query, opts }, { path });
}

export async function searchAllTranscriptIndexes(
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchAllResult> {
  return sendWorker<SearchAllResult>({ type: "searchAll", query, opts });
}

export function warmTranscriptIndexes(sessions: Session[]): void {
  if (backgroundRunning) return;
  const targets = sessions
    .filter((session) => session.sessionId && session.transcriptPath)
    .slice(0, BACKGROUND_LIMIT) as Array<Session & { sessionId: string; transcriptPath: string }>;
  if (!targets.length) return;
  backgroundRunning = true;
  (async () => {
    try {
      for (const session of targets) {
        await indexTranscript(session.transcriptPath, session.sessionId).catch(() => null);
      }
    } finally {
      backgroundRunning = false;
    }
  })();
}

export function startTranscriptMessageMonitor(fetchSessions: () => Promise<Session[]>): void {
  if (monitorStarted) return;
  monitorStarted = true;
  const intervalMs = Math.max(500, Number(process.env.LFG_CHAT_DB_MONITOR_MS ?? 1200) || 1200);
  const tick = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    const started = performance.now();
    try {
      const sessions = await fetchSessions();
      const targets = new Map<string, { sessionId: string; path: string }>();
      for (const session of sessions) {
        if (!session.sessionId || !session.transcriptPath) continue;
        targets.set(session.transcriptPath, { sessionId: session.sessionId, path: session.transcriptPath });
      }
      let imported = 0;
      let indexed = 0;
      for (const target of targets.values()) {
        try {
          const result = await indexTranscript(target.path, target.sessionId);
          imported++;
          indexed += result.indexed;
        } catch (err) {
          const code = (err as { code?: string } | null)?.code;
          if (code !== "ENOENT") {
            traceLog("chat_db_monitor_error", {
              sessionId: target.sessionId,
              path: target.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
      if (indexed || durationMs > 500 || process.env.LFG_TRACE_CHAT_MONITOR === "1") {
        traceLog("chat_db_monitor_tick", {
          sessions: sessions.length,
          targets: targets.size,
          imported,
          indexed,
          durationMs,
        });
      }
    } catch (err) {
      traceLog("chat_db_monitor_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      monitorRunning = false;
    }
  };
  const loop = async () => {
    await tick();
    const timer = setTimeout(loop, intervalMs);
    (timer as { unref?: () => void }).unref?.();
  };
  const timer = setTimeout(loop, intervalMs);
  (timer as { unref?: () => void }).unref?.();
}

export async function shutdownTranscriptIndexWorker(timeoutMs = 2_500): Promise<void> {
  if (!worker) return;
  shuttingDown = true;
  try {
    await Promise.race([
      sendWorker<null>({ type: "shutdown" }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for transcript index worker")), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (err) {
    traceLog("transcript_index_worker_shutdown_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    worker?.terminate();
    worker = null;
    rejectPending(new Error("transcript index worker stopped"));
  }
}
