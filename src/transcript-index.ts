import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import { isCursorTurnEndedLine, normalizeLineMessages, type Session, type SessionMsg } from "./sessions.ts";
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

type IndexedMessageRow = {
  id: string;
  message_id: string | null;
  role: string;
  kind: SessionMsg["kind"];
  ts: number | null;
  text: string;
  byte_offset: number;
};

type IndexedMessageRowidRow = IndexedMessageRow & {
  rowid: number;
};

export type TranscriptIndexCursor = {
  path: string;
  sessionId: string;
  size: number;
  offset: number;
  mtimeMs: number;
  indexedAt: number;
};

const DB_PATH = join(PATHS.data, "transcript-index.sqlite");
const INDEX_TEXT_MAX = 12_000;
const INDEX_CHUNK_BYTES = 1024 * 1024;
const BACKGROUND_LIMIT = 8;
const WAL_CHECKPOINT_INTERVAL_MS = 30_000;

let db: Database | null = null;
let initialized = false;
let backgroundRunning = false;
let monitorStarted = false;
let monitorRunning = false;
let walCheckpointStarted = false;
let walCheckpointRunning = false;
const enqueued = new Set<string>();
const imports = new Map<string, Promise<{ indexed: number; offset: number; size: number }>>();
const directNextOffset = new Map<string, number>();

export function sessionIndexKey(sessionId: string): string {
  return `lfg://session/${sessionId}`;
}

export function isSessionIndexKey(path: string): boolean {
  return path.startsWith("lfg://");
}

function startWalCheckpointTimer(): void {
  if (walCheckpointStarted) return;
  walCheckpointStarted = true;
  const tick = () => {
    if (walCheckpointRunning) return;
    walCheckpointRunning = true;
    try {
      const row = database()
        .query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
        .get();
      if (row && !row.busy && (row.log || row.checkpointed)) {
        traceLog("transcript_index_wal_checkpoint", {
          log: row.log,
          checkpointed: row.checkpointed,
        });
      }
    } catch {
      // Best-effort WAL maintenance only. Busy databases will be retried on the
      // next unref'd timer tick.
    } finally {
      walCheckpointRunning = false;
    }
  };
  const loop = () => {
    tick();
    const timer = setTimeout(loop, WAL_CHECKPOINT_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  const timer = setTimeout(loop, WAL_CHECKPOINT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
}

function database(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 2500");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
  startWalCheckpointTimer();
  return db;
}

function init() {
  if (initialized) return;
  const d = database();
  d.exec(`
    CREATE TABLE IF NOT EXISTS transcript_index_cursors (
      path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      offset INTEGER NOT NULL DEFAULT 0,
      mtime_ms REAL NOT NULL DEFAULT 0,
      indexed_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transcript_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_id TEXT,
      byte_offset INTEGER NOT NULL,
      ts INTEGER,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transcript_messages_session_ts
      ON transcript_messages(session_id, ts);
    CREATE INDEX IF NOT EXISTS transcript_messages_path_offset
      ON transcript_messages(path, byte_offset);
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_messages_fts USING fts5(
      id UNINDEXED,
      session_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    );
  `);
  const version = d.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
  if (version < 2) {
    // The index is derived from transcript JSONL. Version 2 keeps assistant/user
    // text un-clipped so SQLite can serve transcript pages, not just search
    // snippets.
    d.exec(`
      DELETE FROM transcript_messages_fts;
      DELETE FROM transcript_messages;
      DELETE FROM transcript_index_cursors;
      PRAGMA user_version = 2;
    `);
  }
  if (version < 3) {
    // Version 3 stores every normalized transcript message with text. The UI can
    // still filter tool results, but SQLite is the complete read model.
    d.exec(`
      DELETE FROM transcript_messages_fts;
      DELETE FROM transcript_messages;
      DELETE FROM transcript_index_cursors;
      PRAGMA user_version = 3;
    `);
  }
  if (version < 4) {
    // Version 4 switches managed SDK sessions from transcript JSONL ingestion to
    // direct SDK-stream indexing under synthetic lfg:// paths. The old file-keyed
    // rows are derived data and can be rebuilt where file-backed agents still
    // need them.
    d.exec(`
      DELETE FROM transcript_messages_fts;
      DELETE FROM transcript_messages;
      DELETE FROM transcript_index_cursors;
      PRAGMA user_version = 4;
    `);
  }
  initialized = true;
}

function ftsQuery(query: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, 12);
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function snippet(text: string, query: string, window = 220): string {
  const folded = text.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pos = Math.max(
    0,
    Math.min(
      ...terms
        .map((term) => folded.indexOf(term))
        .filter((idx) => idx >= 0),
      text.length,
    ),
  );
  const half = Math.floor(window / 2);
  const from = Math.max(0, pos - half);
  const to = Math.min(text.length, pos + half);
  const clipped = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "..." : ""}${clipped}${to < text.length ? "..." : ""}`;
}

function clippedText(message: SessionMsg): string {
  const text = message.text.trim().replace(/\u0000/g, "");
  if (message.kind === "text") return text;
  return text.length > INDEX_TEXT_MAX ? `${text.slice(0, INDEX_TEXT_MAX)}...` : text;
}

function rowMessage(row: IndexedMessageRow): SessionMsg {
  return {
    id: row.message_id || row.id,
    role: row.role,
    kind: row.kind,
    text: row.text,
    ts: row.ts,
  };
}

function updateCursorInDb(
  d: Database,
  path: string,
  sessionId: string,
  cursor: { size: number; offset: number; mtimeMs: number },
): void {
  d.query(`
      INSERT INTO transcript_index_cursors (path, session_id, size, offset, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id = excluded.session_id,
        size = excluded.size,
        offset = excluded.offset,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
      WHERE excluded.offset >= transcript_index_cursors.offset
    `)
    .run(path, sessionId, cursor.size, cursor.offset, cursor.mtimeMs, Date.now());
}

export function transcriptCursorFor(path: string): TranscriptIndexCursor | null {
  init();
  if (isSessionIndexKey(path)) return null;
  const row = database()
    .query<{
      path: string;
      session_id: string;
      size: number;
      offset: number;
      mtime_ms: number;
      indexed_at: number;
    }, [string]>(
      "SELECT path, session_id, size, offset, mtime_ms, indexed_at FROM transcript_index_cursors WHERE path = ?",
    )
    .get(path);
  if (!row) return null;
  return {
    path: row.path,
    sessionId: row.session_id,
    size: row.size,
    offset: row.offset,
    mtimeMs: row.mtime_ms,
    indexedAt: row.indexed_at,
  };
}

export function transcriptIndexCurrent(path: string): boolean {
  init();
  if (isSessionIndexKey(path)) return true;
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
  init();
  pageTotalCache.delete(path);
  const d = database();
  d.transaction(() => {
    d.query("DELETE FROM transcript_messages_fts WHERE id IN (SELECT id FROM transcript_messages WHERE path = ?)")
      .run(path);
    d.query("DELETE FROM transcript_messages WHERE path = ?").run(path);
    d.query("DELETE FROM transcript_index_cursors WHERE path = ?").run(path);
  })();
}

export function indexTranscriptMessages(
  path: string,
  sessionId: string,
  lines: Array<{ offset: number; messages: SessionMsg[] }>,
  cursor?: { size: number; offset: number; mtimeMs: number },
): number {
  init();
  // Same direct-ownership guard as indexTranscript — callers like the chat
  // tailer reach this entrypoint directly.
  if (!isSessionIndexKey(path) && sessionHasIndexedMessages(sessionId)) return 0;
  const rows: Array<{ id: string; msg: SessionMsg; text: string; offset: number }> = [];
  for (const line of lines) {
    line.messages
      .filter((message) => !!message.text.trim())
      .forEach((msg, index) => {
        rows.push({
          id: `${path}\0${line.offset}\0${index}`,
          msg,
          text: clippedText(msg),
          offset: line.offset,
        });
      });
  }
  if (!rows.length && !cursor) return 0;
  const started = performance.now();
  const d = database();
  const inserted = d.transaction((pending: typeof rows) => {
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = d.query(`
      INSERT INTO transcript_messages_fts (id, session_id, text)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM transcript_messages_fts WHERE id = ?)
    `);
    let insertedRows = 0;
    for (const row of pending) {
      const result = msgStmt.run(
        row.id,
        sessionId,
        path,
        row.msg.id,
        row.offset,
        row.msg.ts,
        row.msg.role,
        row.msg.kind,
        row.text,
      );
      insertedRows += Number(result.changes ?? 0);
      ftsStmt.run(row.id, sessionId, row.text, row.id);
    }
    if (cursor) updateCursorInDb(d, path, sessionId, cursor);
    return insertedRows;
  })(rows);
  traceLog("transcript_index_live", {
    sessionId,
    path,
    lines: lines.length,
    indexed: rows.length,
    inserted,
    offset: cursor?.offset,
    size: cursor?.size,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
  return inserted;
}

function nextDirectOffset(d: Database, path: string): number {
  const cached = directNextOffset.get(path);
  if (cached != null) return cached;
  const max =
    d
      .query<{ max_offset: number | null }, [string]>(
        "SELECT max(byte_offset) AS max_offset FROM transcript_messages WHERE path = ?",
      )
      .get(path)?.max_offset ?? null;
  const next = (max ?? -1) + 1;
  directNextOffset.set(path, next);
  return next;
}

export function indexSessionMessagesDirect(sessionId: string, messages: SessionMsg[]): number {
  init();
  const key = sessionIndexKey(sessionId);
  const d = database();
  let seq = nextDirectOffset(d, key);
  const rows: Array<{ id: string; msg: SessionMsg; text: string; offset: number }> = [];
  messages
    .filter((message) => !!message.text.trim() && !!message.id)
    .forEach((msg, blockIndex) => {
      rows.push({
        id: `${key}\0${msg.id}\0${blockIndex}`,
        msg,
        text: clippedText(msg),
        offset: seq++,
      });
    });
  directNextOffset.set(key, seq);
  if (!rows.length) return 0;
  const started = performance.now();
  const inserted = d.transaction((pending: typeof rows) => {
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = d.query(`
      INSERT INTO transcript_messages_fts (id, session_id, text)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM transcript_messages_fts WHERE id = ?)
    `);
    let insertedRows = 0;
    for (const row of pending) {
      const result = msgStmt.run(
        row.id,
        sessionId,
        key,
        row.msg.id,
        row.offset,
        row.msg.ts,
        row.msg.role,
        row.msg.kind,
        row.text,
      );
      insertedRows += Number(result.changes ?? 0);
      ftsStmt.run(row.id, sessionId, row.text, row.id);
    }
    return insertedRows;
  })(rows);
  if (inserted) pageTotalCache.delete(key);
  traceLog("transcript_index_direct", {
    sessionId,
    path: key,
    messages: messages.length,
    indexed: rows.length,
    inserted,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
  return inserted;
}

export function sessionHasIndexedMessages(sessionId: string): boolean {
  init();
  const key = sessionIndexKey(sessionId);
  return !!database()
    .query<{ one: number }, [string]>("SELECT 1 AS one FROM transcript_messages WHERE path = ? LIMIT 1")
    .get(key);
}

function cursorFor(path: string): { offset: number; size: number; mtimeMs: number } | null {
  init();
  return database()
    .query<{ offset: number; size: number; mtimeMs: number }, [string]>(
      "SELECT offset, size, mtime_ms AS mtimeMs FROM transcript_index_cursors WHERE path = ?",
    )
    .get(path) ?? null;
}

async function indexTranscriptOnce(path: string, sessionId: string): Promise<{
  indexed: number;
  offset: number;
  size: number;
}> {
  if (isSessionIndexKey(path)) return { indexed: 0, offset: 0, size: 0 };
  const started = performance.now();
  init();
  const d = database();
  const st = statSync(path);
  const existingCursor = d
    .query<{ offset: number; session_id: string }, [string]>(
      "SELECT offset, session_id FROM transcript_index_cursors WHERE path = ?",
    )
    .get(path);
  let cursor = existingCursor?.offset ?? 0;
  if (existingCursor && existingCursor.session_id !== sessionId) {
    d.transaction(() => {
      d.query("UPDATE transcript_messages SET session_id = ? WHERE path = ?").run(sessionId, path);
      d.query("UPDATE transcript_index_cursors SET session_id = ? WHERE path = ?").run(sessionId, path);
    })();
  }

  if (st.size < cursor) {
    d.transaction(() => {
      d.query("DELETE FROM transcript_messages_fts WHERE id IN (SELECT id FROM transcript_messages WHERE path = ?)")
        .run(path);
      d.query("DELETE FROM transcript_messages WHERE path = ?").run(path);
      d.query("DELETE FROM transcript_index_cursors WHERE path = ?").run(path);
    })();
    cursor = 0;
  }

  const file = Bun.file(path);
  const decoder = new TextDecoder();
  let indexed = 0;
  let committed = cursor;

  const insert = d.transaction((rows: Array<{ id: string; msg: SessionMsg; text: string; offset: number }>) => {
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = d.query(`
      INSERT INTO transcript_messages_fts (id, session_id, text)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM transcript_messages_fts WHERE id = ?)
    `);
    for (const row of rows) {
      msgStmt.run(
        row.id,
        sessionId,
        path,
        row.msg.id,
        row.offset,
        row.msg.ts,
        row.msg.role,
        row.msg.kind,
        row.text,
      );
      ftsStmt.run(row.id, sessionId, row.text, row.id);
    }
    updateCursorInDb(d, path, sessionId, { size: st.size, offset: committed, mtimeMs: st.mtimeMs });
  });

  while (committed < st.size) {
    let end = Math.min(st.size, committed + INDEX_CHUNK_BYTES);
    let bytes = new Uint8Array(await file.slice(committed, end).arrayBuffer());
    let scanEnd = bytes.lastIndexOf(10);
    while (scanEnd < 0 && end < st.size) {
      // Some providers persist a whole turn as one very large JSONL record. If a
      // single line is larger than INDEX_CHUNK_BYTES, stopping here wedges the
      // cursor forever and the database never catches up for that session.
      end = Math.min(st.size, end + INDEX_CHUNK_BYTES);
      bytes = new Uint8Array(await file.slice(committed, end).arrayBuffer());
      scanEnd = bytes.lastIndexOf(10);
    }
    if (scanEnd < 0) break;
    scanEnd += 1;

    const rows: Array<{ id: string; msg: SessionMsg; text: string; offset: number }> = [];
    // Start of a trailing run of volatile cursor `turn_ended` markers within this
    // chunk. A real (message-bearing) line resets it — only a file-trailing run holds.
    let holdStart = scanEnd;
    for (let lineStart = 0; lineStart < scanEnd; ) {
      let lineEnd = lineStart;
      while (lineEnd < scanEnd && bytes[lineEnd] !== 10) lineEnd++;
      if (lineEnd > lineStart) {
        const lineOffset = committed + lineStart;
        const line = decoder.decode(bytes.subarray(lineStart, lineEnd));
        const messages = normalizeLineMessages(line).filter((message) => !!message.text.trim());
        if (messages.length === 0 && isCursorTurnEndedLine(line)) {
          if (holdStart === scanEnd) holdStart = lineStart;
        } else {
          holdStart = scanEnd;
          messages.forEach((msg, index) => {
            rows.push({
              id: `${path}\0${lineOffset}\0${index}`,
              msg,
              text: clippedText(msg),
              offset: lineOffset,
            });
          });
        }
      }
      lineStart = lineEnd + 1;
    }

    // cursor rewrites a file-trailing `turn_ended` marker in place on its next turn,
    // so holding the byte cursor before it keeps that turn's user line from being
    // skipped. Only apply at EOF; a marker with content after it is already durable.
    const atEof = committed + scanEnd === st.size;
    const advance = atEof && holdStart < scanEnd ? holdStart : scanEnd;
    committed += advance;
    indexed += rows.length;
    insert(rows);
    if (advance < scanEnd || scanEnd === 0) break;
  }

  if (committed === st.size) insert([]);
  traceLog("transcript_index", {
    sessionId,
    path,
    indexed,
    offset: committed,
    size: st.size,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
  return { indexed, offset: committed, size: st.size };
}

export async function indexTranscript(path: string, sessionId: string): Promise<{
  indexed: number;
  offset: number;
  size: number;
}> {
  if (isSessionIndexKey(path)) return { indexed: 0, offset: 0, size: 0 };
  // A direct-indexed session owns its transcript: its harness streams rows in
  // under the lfg:// key. File-ingesting a native transcript (e.g. the codex
  // rollout JSONL that shares the session id via thread mapping) would insert
  // a second, duplicated copy of every message under a different path.
  if (sessionHasIndexedMessages(sessionId)) {
    traceLog("transcript_index_skip_direct", { sessionId, path });
    return { indexed: 0, offset: 0, size: 0 };
  }
  const existing = imports.get(path);
  if (existing) return existing;
  const pending = indexTranscriptOnce(path, sessionId).finally(() => {
    imports.delete(path);
  });
  imports.set(path, pending);
  return pending;
}

async function importTranscriptForRead(path: string, sessionId: string): Promise<void> {
  if (isSessionIndexKey(path)) return;
  try {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "ENOENT") throw err;
      return;
    }
    const cursor = transcriptCursorFor(path);
    if (cursor && cursor.offset === st.size && cursor.size === st.size && cursor.mtimeMs === st.mtimeMs) return;
    if (cursor) {
      enqueueTranscriptIndex(path, sessionId);
      return;
    }
    await indexTranscript(path, sessionId);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      traceLog("chat_db_import_error", {
        sessionId,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function enqueueTranscriptIndex(path: string, sessionId: string): void {
  if (isSessionIndexKey(path)) return;
  if (sessionHasIndexedMessages(sessionId)) return;
  if (enqueued.has(path)) return;
  enqueued.add(path);
  traceLog("transcript_index_enqueue", { sessionId, path });
  setTimeout(() => {
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
}

// Per-path message total, cached against the indexed byte offset. The count(*)
// over a path's rows was run on every page load (a few ms on a large index);
// the total only changes when new rows are indexed (offset advances), so paging
// through an unchanged transcript reuses the cached count instead of re-scanning.
const pageTotalCache = new Map<string, { offset: number; total: number }>();

export async function indexedMessagePage(
  path: string,
  sessionId: string,
  opts: { before?: number | null; limit?: number } = {},
): Promise<{
  messages: SessionMsg[];
  nextBefore: number | null;
  total: number;
}> {
  const started = performance.now();
  init();
  await importTranscriptForRead(path, sessionId);
  const d = database();
  const cursor = cursorFor(path);
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 220));
  const before = Math.max(0, opts.before ?? Number.MAX_SAFE_INTEGER);
  const rows = d
    .query<IndexedMessageRow, [string, number, number]>(`
        SELECT id, message_id, role, kind, ts, text, byte_offset
        FROM transcript_messages
        WHERE path = ? AND byte_offset < ?
        ORDER BY byte_offset DESC, id DESC
        LIMIT ?
      `)
    .all(path, before, limit);
  if (!rows.length) {
    traceLog("transcript_page", {
      sessionId,
      path,
      messages: 0,
      nextBefore: null,
      total: 0,
      indexedOffset: cursor?.offset ?? 0,
      indexedSize: cursor?.size ?? 0,
      cold: !cursor,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    });
    return { messages: [], nextBefore: null, total: 0 };
  }
  rows.reverse();
  const oldest = rows[0];
  const nextBefore = oldest.byte_offset > 0 ? oldest.byte_offset : null;
  const totalKey = isSessionIndexKey(path)
    ? (d
        .query<{ max_offset: number | null }, [string]>(
          "SELECT max(byte_offset) AS max_offset FROM transcript_messages WHERE path = ?",
        )
        .get(path)?.max_offset ?? 0)
    : (cursor?.offset ?? 0);
  const cachedTotal = pageTotalCache.get(path);
  const total =
    cachedTotal && cachedTotal.offset === totalKey
      ? cachedTotal.total
      : (() => {
          const n =
            d
              .query<{ count: number }, [string]>(
                "SELECT count(*) AS count FROM transcript_messages WHERE path = ?",
              )
              .get(path)?.count ?? rows.length;
          pageTotalCache.set(path, { offset: totalKey, total: n });
          return n;
        })();
  traceLog("transcript_page", {
    sessionId,
    path,
    messages: rows.length,
    nextBefore,
    total,
    indexedOffset: cursor?.offset ?? 0,
    indexedSize: cursor?.size ?? 0,
    cold: !cursor,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
  return {
    messages: rows.map(rowMessage),
    nextBefore,
    total,
  };
}

export async function indexedRecentMessages(
  path: string,
  sessionId: string,
  limit = 40,
): Promise<SessionMsg[]> {
  const page = await indexedMessagePage(path, sessionId, { limit });
  return page.messages;
}

export function indexedMessagesAfterRowid(
  path: string,
  sessionId: string,
  afterRowid: number,
  limit = 200,
): { messages: SessionMsg[]; maxRowid: number } {
  init();
  const d = database();
  const bounded = Math.max(0, Math.min(20_000, Math.floor(limit)));
  const cursor = Math.max(0, Math.floor(afterRowid));
  const rows = bounded
    ? d
        .query<IndexedMessageRowidRow, [string, number, number]>(`
          SELECT rowid, id, message_id, role, kind, ts, text, byte_offset
          FROM transcript_messages
          WHERE path = ? AND rowid > ?
          ORDER BY rowid ASC
          LIMIT ?
        `)
        .all(path, cursor, bounded)
    : [];
  const maxRowid = rows.length
    ? rows[rows.length - 1].rowid
    : d
        .query<{ max_rowid: number | null }, [string]>(
          "SELECT max(rowid) AS max_rowid FROM transcript_messages WHERE path = ?",
        )
        .get(path)?.max_rowid ?? 0;
  if (rows.length) {
    traceLog("transcript_after_rowid", {
      sessionId,
      path,
      afterRowid: cursor,
      messages: rows.length,
      maxRowid,
    });
  }
  return {
    messages: rows.map(rowMessage),
    maxRowid,
  };
}

export async function searchTranscriptIndex(
  path: string,
  sessionId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<{ total: number; scanned: number; truncated: boolean; results: IndexedTranscriptMatch[] }> {
  await importTranscriptForRead(path, sessionId);
  init();
  const q = ftsQuery(query);
  if (!q) return { total: 0, scanned: 0, truncated: false, results: [] };
  const limit = Math.max(1, Math.min(50, opts.limit ?? 12));
  const d = database();
  const rows = d
    .query<{
      session_id: string;
      path: string;
      role: string;
      kind: SessionMsg["kind"];
      ts: number | null;
      text: string;
      byte_offset: number;
    }, [string, string, number]>(`
      SELECT m.session_id, m.path, m.role, m.kind, m.ts, m.text, m.byte_offset
      FROM transcript_messages_fts f
      JOIN transcript_messages m ON m.id = f.id
      WHERE m.session_id = ? AND transcript_messages_fts MATCH ?
      ORDER BY COALESCE(m.ts, 0) DESC, m.byte_offset DESC
      LIMIT ?
    `)
    .all(sessionId, q, limit);

  return {
    total: rows.length,
    scanned: d
      .query<{ count: number }, [string]>("SELECT count(*) AS count FROM transcript_messages WHERE session_id = ?")
      .get(sessionId)?.count ?? 0,
    truncated: false,
    results: rows.reverse().map((row) => ({
      sessionId: row.session_id,
      path: row.path,
      role: row.role,
      kind: row.kind,
      ts: row.ts,
      snippet: snippet(row.text, query),
      offset: row.byte_offset,
    })),
  };
}

export async function searchAllTranscriptIndexes(
  query: string,
  opts: { limit?: number } = {},
): Promise<{ total: number; results: IndexedTranscriptMatch[] }> {
  init();
  const q = ftsQuery(query);
  if (!q) return { total: 0, results: [] };
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  const rows = database()
    .query<{
      session_id: string;
      path: string;
      role: string;
      kind: SessionMsg["kind"];
      ts: number | null;
      text: string;
      byte_offset: number;
    }, [string, number]>(`
      SELECT m.session_id, m.path, m.role, m.kind, m.ts, m.text, m.byte_offset
      FROM transcript_messages_fts f
      JOIN transcript_messages m ON m.id = f.id
      WHERE transcript_messages_fts MATCH ?
      ORDER BY COALESCE(m.ts, 0) DESC, m.byte_offset DESC
      LIMIT ?
    `)
    .all(q, limit);
  return {
    total: rows.length,
    results: rows.map((row) => ({
      sessionId: row.session_id,
      path: row.path,
      role: row.role,
      kind: row.kind,
      ts: row.ts,
      snippet: snippet(row.text, query),
      offset: row.byte_offset,
    })),
  };
}

export function warmTranscriptIndexes(sessions: Session[]): void {
  if (backgroundRunning) return;
  const targets = sessions
    .filter((session) => session.sessionId && session.transcriptPath && !isSessionIndexKey(session.transcriptPath))
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
        if (isSessionIndexKey(session.transcriptPath)) continue;
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
