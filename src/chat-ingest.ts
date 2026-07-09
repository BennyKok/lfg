import { statSync } from "node:fs";
import { isCursorTurnEndedLine, normalizeLineMessages, type Session, type SessionMsg } from "./sessions.ts";
import {
  deleteTranscriptIndexForPath,
  indexTranscriptMessages,
  isSessionIndexKey,
  transcriptCursorFor,
  transcriptIndexCurrent,
} from "./transcript-index.ts";
import { traceLog } from "./trace-log.ts";

export type ChatIngestEvent = {
  sessionId: string;
  path: string;
  offset: number;
  messages: SessionMsg[];
};

export type ChatIngestSubscriber = (event: ChatIngestEvent) => void;

export type ChatIngestResult = {
  indexed: number;
  lines: number;
  offset: number;
  size: number;
  unchanged: boolean;
};

const CHAT_CHUNK_BYTES = 1024 * 1024;
const LIVE_POLL_MS = 700;
const MONITOR_POLL_MS = Math.max(500, Number(process.env.LFG_CHAT_DB_MONITOR_MS ?? 1200) || 1200);
const WARM_LIMIT = 8;
const encoder = new TextEncoder();

function emptyIngestResult(): ChatIngestResult {
  return { indexed: 0, lines: 0, offset: 0, size: 0, unchanged: true };
}

class ChatTranscriptTailer {
  path: string;
  sessionId: string;
  private offset: number | null = null;
  private partial = "";
  private partialOffset: number | null = null;
  private lastSize = -1;
  private lastMtimeMs = -1;
  private importing: Promise<ChatIngestResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<ChatIngestSubscriber>();

  constructor(path: string, sessionId: string) {
    this.path = path;
    this.sessionId = sessionId;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  subscribe(cb: ChatIngestSubscriber): () => void {
    this.subscribers.add(cb);
    this.start();
    void this.catchUp("subscribe").catch((err) => this.logError("chat_ingest_subscribe_error", err));
    return () => {
      this.subscribers.delete(cb);
      if (!this.subscribers.size) this.stop();
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.catchUp("live").catch((err) => this.logError("chat_ingest_live_error", err));
    }, LIVE_POLL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async catchUp(reason = "manual"): Promise<ChatIngestResult> {
    if (this.importing) return this.importing;
    this.importing = this.catchUpOnce(reason).finally(() => {
      this.importing = null;
    });
    return this.importing;
  }

  private async catchUpOnce(reason: string): Promise<ChatIngestResult> {
    const started = performance.now();
    const st = statSync(this.path);
    if (st.size === this.lastSize && st.mtimeMs === this.lastMtimeMs) {
      const cursor = transcriptCursorFor(this.path);
      return {
        indexed: 0,
        lines: 0,
        offset: cursor?.offset ?? this.offset ?? 0,
        size: st.size,
        unchanged: true,
      };
    }

    let cursor = transcriptCursorFor(this.path);
    if (cursor && cursor.sessionId !== this.sessionId) {
      this.offset = cursor.offset;
    }
    if (cursor && st.size < cursor.offset) {
      deleteTranscriptIndexForPath(this.path);
      cursor = null;
      this.offset = 0;
      this.partial = "";
      this.partialOffset = null;
    }

    let readOffset = this.offset ?? cursor?.offset ?? 0;
    if (st.size < readOffset) {
      readOffset = cursor?.offset ?? 0;
      this.partial = "";
      this.partialOffset = null;
    }

    let committed = cursor?.offset ?? 0;
    // Skipping ahead to the shared committed cursor is only valid when nobody
    // is listening in THIS process. Self-indexing SDK harnesses advance the
    // sqlite cursor from their own process; if serve's tailer clamps its read
    // offset up to that cursor, it never parses the appended lines and its WS
    // subscribers receive no "msg" events at all — the live view goes dead,
    // clients hit the stall watchdog, and every session renders only the
    // snapshot tail. With subscribers we keep our own in-memory read offset
    // and re-parse those bytes purely to publish them (re-indexing is
    // idempotent: INSERT OR IGNORE on deterministic ids, monotonic cursor).
    if (!this.subscribers.size && readOffset < committed) readOffset = committed;

    const file = Bun.file(this.path);
    const decoder = new TextDecoder();
    let indexed = 0;
    let completedLines = 0;

    while (readOffset < st.size) {
      const chunkStart = readOffset;
      const chunkEnd = Math.min(st.size, chunkStart + CHAT_CHUNK_BYTES);
      const bytes = new Uint8Array(await file.slice(chunkStart, chunkEnd).arrayBuffer());
      readOffset = chunkEnd;
      this.offset = readOffset;

      const text = decoder.decode(bytes);
      const previousPartial = this.partial;
      const combined = previousPartial + text;
      const parts = combined.split("\n");
      this.partial = parts.pop() ?? "";
      let lineOffset = previousPartial ? (this.partialOffset ?? committed) : chunkStart;
      const complete: Array<{ offset: number; messages: SessionMsg[]; volatile: boolean }> = [];

      for (const line of parts) {
        const offset = lineOffset;
        lineOffset += encoder.encode(line).length + 1;
        const messages = line ? normalizeLineMessages(line) : [];
        // A cursor `turn_ended` marker with no surfaced message gets rewritten in
        // place by the next turn (see isCursorTurnEndedLine) — never commit past it.
        const volatile = messages.length === 0 && !!line && isCursorTurnEndedLine(line);
        complete.push({ offset, messages, volatile });
        completedLines++;
      }

      this.partialOffset = this.partial ? lineOffset : null;
      if (!complete.length) continue;

      // At EOF, hold the commit cursor at the start of a trailing run of volatile
      // markers so cursor's in-place rewrite (its next user turn) is re-read next
      // poll instead of skipped. Inert for append-only agents (no volatile lines).
      let hold = complete.length;
      if (chunkEnd === st.size) while (hold > 0 && complete[hold - 1].volatile) hold--;
      const emit = hold < complete.length ? complete.slice(0, hold) : complete;
      committed = hold < complete.length ? complete[hold].offset : lineOffset;

      indexed += indexTranscriptMessages(this.path, this.sessionId, emit, {
        size: st.size,
        offset: committed,
        mtimeMs: st.mtimeMs,
      });
      if (emit.length) this.publish(emit);

      if (hold < complete.length) {
        // Held back over a trailing marker: drop any in-memory partial and resume
        // from the marker's start next poll. Nothing real follows it in the file.
        this.offset = committed;
        this.partial = "";
        this.partialOffset = null;
        break;
      }
    }

    if (!this.partial && committed === st.size) {
      indexTranscriptMessages(this.path, this.sessionId, [], {
        size: st.size,
        offset: committed,
        mtimeMs: st.mtimeMs,
      });
    }

    this.lastSize = st.size;
    this.lastMtimeMs = st.mtimeMs;
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    if (completedLines || durationMs > 500 || process.env.LFG_TRACE_CHAT_MONITOR === "1") {
      traceLog("chat_ingest_tick", {
        sessionId: this.sessionId,
        path: this.path,
        reason,
        lines: completedLines,
        indexed,
        subscribers: this.subscribers.size,
        offset: committed,
        size: st.size,
        partialBytes: this.partial ? encoder.encode(this.partial).length : 0,
        durationMs,
      });
    }

    return { indexed, lines: completedLines, offset: committed, size: st.size, unchanged: false };
  }

  private publish(lines: Array<{ offset: number; messages: SessionMsg[] }>): void {
    if (!this.subscribers.size) return;
    for (const line of lines) {
      if (!line.messages.length) continue;
      const event: ChatIngestEvent = {
        sessionId: this.sessionId,
        path: this.path,
        offset: line.offset,
        messages: line.messages,
      };
      for (const cb of this.subscribers) {
        try {
          cb(event);
        } catch (err) {
          this.logError("chat_ingest_subscriber_error", err);
        }
      }
    }
  }

  private logError(event: string, err: unknown): void {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return;
    traceLog(event, {
      sessionId: this.sessionId,
      path: this.path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const tailers = new Map<string, ChatTranscriptTailer>();
let monitorStarted = false;
let monitorRunning = false;
let warmRunning = false;

// Backends that index their own transcript in-process as messages stream (see
// src/agents/backends/*-session.ts). The monitor must not re-read/re-index their
// files on serve's event loop while the index cursor is already current — it only
// backfills when the in-process indexer has fallen behind or never ran (e.g. a
// session started before index-at-source shipped, or a best-effort catch-up that
// dropped). Any residual gap still self-heals via the transcript read path.
const SELF_INDEXING_AGENTS = new Set<Session["agent"]>(["aisdk", "opencode", "codex-aisdk"]);

function tailerFor(path: string, sessionId: string): ChatTranscriptTailer {
  let tailer = tailers.get(path);
  if (!tailer) {
    tailer = new ChatTranscriptTailer(path, sessionId);
    tailers.set(path, tailer);
  } else {
    tailer.setSession(sessionId);
  }
  return tailer;
}

export function tailerHasSubscribers(path: string): boolean {
  if (isSessionIndexKey(path)) return false;
  return (tailers.get(path)?.subscriberCount ?? 0) > 0;
}

export function subscribeChatTranscript(
  path: string,
  sessionId: string,
  cb: ChatIngestSubscriber,
): () => void {
  if (isSessionIndexKey(path)) return () => {};
  return tailerFor(path, sessionId).subscribe(cb);
}

export function ensureChatTranscriptCaughtUp(
  path: string,
  sessionId: string,
  reason = "manual",
): Promise<ChatIngestResult> {
  if (isSessionIndexKey(path)) return Promise.resolve(emptyIngestResult());
  return tailerFor(path, sessionId).catchUp(reason);
}

export function warmChatTranscripts(sessions: Session[], limit = WARM_LIMIT): void {
  if (warmRunning) return;
  const targets = sessions
    .filter((session) => session.sessionId && session.transcriptPath && !isSessionIndexKey(session.transcriptPath))
    .slice(0, limit) as Array<Session & { sessionId: string; transcriptPath: string }>;
  if (!targets.length) return;
  warmRunning = true;
  (async () => {
    try {
      for (const session of targets) {
        await ensureChatTranscriptCaughtUp(session.transcriptPath, session.sessionId, "warm").catch(() => null);
      }
    } finally {
      warmRunning = false;
    }
  })();
}

export function startChatIngestMonitor(fetchSessions: () => Promise<Session[]>): void {
  if (monitorStarted) return;
  monitorStarted = true;
  const tick = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    const started = performance.now();
    try {
      const sessions = await fetchSessions();
      const targets = new Map<string, { sessionId: string; path: string; agent: Session["agent"] }>();
      for (const session of sessions) {
        if (!session.sessionId || !session.transcriptPath) continue;
        if (isSessionIndexKey(session.transcriptPath)) continue;
        targets.set(session.transcriptPath, {
          sessionId: session.sessionId,
          path: session.transcriptPath,
          agent: session.agent,
        });
      }
      let swept = 0;
      let imported = 0;
      let indexed = 0;
      let skipped = 0;
      let selfIndexed = 0;
      for (const target of targets.values()) {
        if (tailerHasSubscribers(target.path)) {
          skipped++;
          continue;
        }
        // Self-indexing backend that is already caught up in its own process:
        // don't re-read/re-index it on serve's loop. Only fall through to catch-up
        // when its cursor is behind (never self-indexed, or the in-process
        // best-effort catch-up dropped).
        if (SELF_INDEXING_AGENTS.has(target.agent) && transcriptIndexCurrent(target.path)) {
          selfIndexed++;
          continue;
        }
        swept++;
        try {
          const result = await ensureChatTranscriptCaughtUp(target.path, target.sessionId, "monitor");
          imported++;
          indexed += result.indexed;
        } catch (err) {
          const code = (err as { code?: string } | null)?.code;
          if (code !== "ENOENT") {
            traceLog("chat_ingest_monitor_error", {
              sessionId: target.sessionId,
              path: target.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
      if (indexed || durationMs > 500 || process.env.LFG_TRACE_CHAT_MONITOR === "1") {
        traceLog("chat_ingest_monitor_tick", {
          sessions: sessions.length,
          targets: targets.size,
          swept,
          selfIndexed,
          imported,
          skipped,
          indexed,
          durationMs,
        });
      }
    } catch (err) {
      traceLog("chat_ingest_monitor_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      monitorRunning = false;
    }
  };
  const loop = async () => {
    await tick();
    const timer = setTimeout(loop, MONITOR_POLL_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  const timer = setTimeout(loop, MONITOR_POLL_MS);
  (timer as { unref?: () => void }).unref?.();
}
