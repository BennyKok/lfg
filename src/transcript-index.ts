import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import { normalizeLineMessages, type Session, type SessionMsg } from "./sessions.ts";
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

const DB_PATH = join(PATHS.data, "transcript-index.sqlite");
const INDEX_TEXT_MAX = 12_000;
const INDEX_CHUNK_BYTES = 1024 * 1024;
const BACKGROUND_LIMIT = 8;

let db: Database | null = null;
let initialized = false;
let backgroundRunning = false;
let monitorStarted = false;
let monitorRunning = false;
const enqueued = new Set<string>();
const imports = new Map<string, Promise<{ indexed: number; offset: number; size: number }>>();

function database(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 2500");
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

export function indexTranscriptMessages(
  path: string,
  sessionId: string,
  lines: Array<{ offset: number; messages: SessionMsg[] }>,
): number {
  init();
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
  if (!rows.length) return 0;
  const started = performance.now();
  const d = database();
  d.transaction((pending: typeof rows) => {
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
    for (const row of pending) {
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
  })(rows);
  traceLog("transcript_index_live", {
    sessionId,
    path,
    lines: lines.length,
    indexed: rows.length,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  });
  return rows.length;
}

function cursorFor(path: string): { offset: number; size: number } | null {
  init();
  return database()
    .query<{ offset: number; size: number }, [string]>(
      "SELECT offset, size FROM transcript_index_cursors WHERE path = ?",
    )
    .get(path) ?? null;
}

async function indexTranscriptOnce(path: string, sessionId: string): Promise<{
  indexed: number;
  offset: number;
  size: number;
}> {
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
    d.query(`
      INSERT INTO transcript_index_cursors (path, session_id, size, offset, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id = excluded.session_id,
        size = excluded.size,
        offset = excluded.offset,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `).run(path, sessionId, st.size, committed, st.mtimeMs, Date.now());
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
    if (scanEnd < 0) {
      scanEnd = bytes.length;
    } else {
      scanEnd += 1;
    }

    const rows: Array<{ id: string; msg: SessionMsg; text: string; offset: number }> = [];
    for (let lineStart = 0; lineStart < scanEnd; ) {
      let lineEnd = lineStart;
      while (lineEnd < scanEnd && bytes[lineEnd] !== 10) lineEnd++;
      if (lineEnd > lineStart) {
        const lineOffset = committed + lineStart;
        const line = decoder.decode(bytes.subarray(lineStart, lineEnd));
        const messages = normalizeLineMessages(line).filter((message) => !!message.text.trim());
        messages.forEach((msg, index) => {
          rows.push({
            id: `${path}\0${lineOffset}\0${index}`,
            msg,
            text: clippedText(msg),
            offset: lineOffset,
          });
        });
      }
      lineStart = lineEnd + 1;
    }

    committed += scanEnd;
    indexed += rows.length;
    insert(rows);
    if (scanEnd === 0) break;
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
  const existing = imports.get(path);
  if (existing) return existing;
  const pending = indexTranscriptOnce(path, sessionId).finally(() => {
    imports.delete(path);
  });
  imports.set(path, pending);
  return pending;
}

async function importTranscriptForRead(path: string, sessionId: string): Promise<void> {
  try {
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
  const total =
    d
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM transcript_messages WHERE path = ?",
      )
      .get(path)?.count ?? rows.length;
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
