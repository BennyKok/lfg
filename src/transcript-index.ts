import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import { isCursorTurnEndedLine, normalizeLineMessages, type Session, type SessionMsg } from "./sessions.ts";
import { traceLog } from "./trace-log.ts";
import {
  imageArtifactToMessage,
  listAllArtifacts,
  type ImageArtifact,
  type ImageArtifactMessage,
} from "./artifacts.ts";

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
  order_seq: number;
  // Joined from the artifacts table when present (same SQLite DB).
  artifact_id?: string | null;
  artifact_media?: string | null;
  artifact_name?: string | null;
  artifact_mime_type?: string | null;
  artifact_size?: number | null;
  artifact_caption?: string | null;
  artifact_alt?: string | null;
  artifact_title?: string | null;
  artifact_version?: number | null;
  artifact_updated_at?: number | null;
  artifact_refresh_json?: string | null;
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

function dbPath(): string {
  return join(PATHS.data, "transcript-index.sqlite");
}
const INDEX_TEXT_MAX = 12_000;
const INDEX_CHUNK_BYTES = 1024 * 1024;
const BACKGROUND_LIMIT = 8;
const WAL_CHECKPOINT_INTERVAL_MS = 30_000;
const TRANSCRIPT_BUSY_TIMEOUT_MS = 15_000;

let db: Database | null = null;
let dbOpenedPath: string | null = null;
let initialized = false;
let backgroundRunning = false;
let monitorStarted = false;
let monitorRunning = false;
let walCheckpointStarted = false;
let walCheckpointRunning = false;
const enqueued = new Set<string>();
const imports = new Map<string, Promise<{ indexed: number; offset: number; size: number }>>();
const directNextOffset = new Map<string, number>();
type IndexedArtifactEvent = { path: string; sessionId: string; message: ImageArtifactMessage };
const artifactListeners = new Set<(event: IndexedArtifactEvent) => void>();

/** Live transports subscribe to the same committed row used by transcript reads. */
export function subscribeIndexedArtifactMessages(
  listener: (event: IndexedArtifactEvent) => void,
): () => void {
  artifactListeners.add(listener);
  return () => artifactListeners.delete(listener);
}

// Media files stay on disk, but artifact *metadata* and transcript *order* both
// live in this SQLite DB. Reads JOIN the two tables so image/video/html cards
// come from the same query path as prose — never a second poll stream that
// re-sorts by timestamp and lands media out of place.
const ARTIFACT_MESSAGE_SELECT = `
  m.id, m.message_id, m.role, m.kind, m.ts, m.text, m.byte_offset, m.order_seq,
  a.id AS artifact_id,
  a.media AS artifact_media,
  a.name AS artifact_name,
  a.mime_type AS artifact_mime_type,
  a.size AS artifact_size,
  a.caption AS artifact_caption,
  a.alt AS artifact_alt,
  a.title AS artifact_title,
  a.version AS artifact_version,
  a.updated_at AS artifact_updated_at,
  a.refresh_json AS artifact_refresh_json
`;

function upsertArtifactRow(d: Database, artifact: ImageArtifact): void {
  d.query(`
    INSERT INTO artifacts (
      id, session_id, media, created_at, updated_at, file_path, name, mime_type,
      size, caption, alt, title, version, source_path, source_mtime_ms, refresh_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id = excluded.session_id,
      media = excluded.media,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      file_path = excluded.file_path,
      name = excluded.name,
      mime_type = excluded.mime_type,
      size = excluded.size,
      caption = excluded.caption,
      alt = excluded.alt,
      title = excluded.title,
      version = excluded.version,
      source_path = excluded.source_path,
      source_mtime_ms = excluded.source_mtime_ms,
      refresh_json = excluded.refresh_json
  `).run(
    artifact.id,
    artifact.sessionId,
    artifact.media ?? "image",
    artifact.createdAt,
    artifact.updatedAt ?? null,
    artifact.filePath,
    artifact.name,
    artifact.mimeType,
    artifact.size,
    artifact.caption ?? null,
    artifact.alt ?? null,
    artifact.title ?? null,
    artifact.version ?? null,
    artifact.sourcePath,
    artifact.sourceMtimeMs ?? null,
    artifact.refresh ? JSON.stringify(artifact.refresh) : null,
  );
}

function deleteArtifactRow(d: Database, artifactId: string): void {
  d.query("DELETE FROM artifacts WHERE id = ?").run(artifactId);
  d.query(
    "DELETE FROM transcript_messages_fts WHERE id IN (SELECT id FROM transcript_messages WHERE message_id = ?)",
  ).run(`artifact-${artifactId}`);
  d.query("DELETE FROM transcript_messages WHERE message_id = ?").run(`artifact-${artifactId}`);
}

/** Mirror one durable artifact into the joined artifacts table + ordered transcript row. */
export function indexArtifactMessage(path: string, sessionId: string, artifact: ImageArtifact): number {
  init();
  const d = database();
  const message = imageArtifactToMessage(artifact);
  const messageId = message.id!;
  const rowId = `${path}\0artifact\0${artifact.id}`;
  const text = clippedText(message);
  // Identity is global (artifact-<id>). If the row already lives under any
  // path for this session, update in place rather than inventing a second
  // ordered position.
  const existing = d
    .query<{ id: string; path: string; session_id: string; byte_offset: number }, [string]>(
      "SELECT id, path, session_id, byte_offset FROM transcript_messages WHERE message_id = ? LIMIT 1",
    )
    .get(messageId);

  const inserted = d.transaction(() => {
    upsertArtifactRow(d, artifact);
    if (existing) {
      // Stable HTML cards re-publish under the same message id. Update the
      // existing ordered row in place so live clients refresh without a second
      // stream inventing a new position.
      if (existing.path !== path || existing.session_id !== sessionId) {
        const offset = nextDirectOffset(d, path);
        const orderSeq = nextOrderSeq(d, path);
        d.query(`
          UPDATE transcript_messages
             SET session_id = ?, path = ?, byte_offset = ?, order_seq = ?,
                 ts = ?, role = ?, kind = ?, text = ?
           WHERE id = ?
        `).run(sessionId, path, offset, orderSeq, message.ts, message.role, message.kind, text, existing.id);
        directNextOffset.set(path, offset + 1);
      } else {
        d.query(`
          UPDATE transcript_messages
             SET ts = ?, role = ?, kind = ?, text = ?
           WHERE id = ?
        `).run(message.ts, message.role, message.kind, text, existing.id);
      }
      d.query("DELETE FROM transcript_messages_fts WHERE id = ?").run(existing.id);
      d.query(`
        INSERT INTO transcript_messages_fts (id, session_id, text)
        VALUES (?, ?, ?)
      `).run(existing.id, sessionId, text);
      pageTotalCache.delete(existing.path);
      pageTotalCache.delete(path);
      return 0;
    }

    const offset = nextDirectOffset(d, path);
    const orderSeq = nextOrderSeq(d, path);
    directNextOffset.set(path, offset + 1);
    const result = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, order_seq, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rowId,
      sessionId,
      path,
      messageId,
      offset,
      orderSeq,
      message.ts,
      message.role,
      message.kind,
      text,
    );
    const inserted = Number(result.changes ?? 0);
    if (inserted) {
      d.query(`
        INSERT INTO transcript_messages_fts (id, session_id, text)
        SELECT ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM transcript_messages_fts WHERE id = ?)
      `).run(rowId, sessionId, text, rowId);
      pageTotalCache.delete(path);
    }
    return inserted;
  }).immediate();
  const event = { path, sessionId, message };
  for (const listener of artifactListeners) {
    try {
      listener(event);
    } catch {
      // A broken client transport must not roll back a committed artifact.
    }
  }
  return inserted;
}

export function removeIndexedArtifact(artifactId: string): void {
  init();
  deleteArtifactRow(database(), artifactId);
  pageTotalCache.clear();
}

export function indexedArtifactPlacement(artifactId: string): string | null {
  init();
  return database()
    .query<{ path: string }, [string]>(
      "SELECT path FROM transcript_messages WHERE message_id = ? LIMIT 1",
    )
    .get(`artifact-${artifactId}`)?.path ?? null;
}

/** Update the joined artifacts row (and existing transcript row if any) without inventing a path. */
export function syncArtifactIndex(artifact: ImageArtifact): number {
  init();
  const existing = database()
    .query<{ path: string }, [string]>(
      "SELECT path FROM transcript_messages WHERE message_id = ? LIMIT 1",
    )
    .get(`artifact-${artifact.id}`);
  // Storage/gallery records are not transcript placements. Only update an
  // artifact that was explicitly displayed through indexArtifactMessage.
  if (!existing) return 0;
  return indexArtifactMessage(existing.path, artifact.sessionId, artifact);
}

/**
 * Artifact manifests are already durable on disk. Their SQLite mirror must not
 * inherit the long writer wait used by transcript-producing harnesses because
 * that would freeze serve's event loop (including voice and ping). Callers can
 * retry this mirror from the latest manifest without losing authored data.
 */
export function syncArtifactIndexNonBlocking(
  artifact: ImageArtifact,
  busyTimeoutMs = 100,
): number {
  const boundedTimeout = Math.max(0, Math.min(1_000, Math.floor(busyTimeoutMs)));
  // Set the short wait while opening/initializing too: first access may need a
  // schema write, and waiting there with the default timeout would still stall
  // startup before this function reached the mirror transaction.
  const d = database(boundedTimeout);
  d.exec(`PRAGMA busy_timeout = ${boundedTimeout}`);
  try {
    init(boundedTimeout);
    return syncArtifactIndex(artifact);
  } finally {
    d.exec(`PRAGMA busy_timeout = ${TRANSCRIPT_BUSY_TIMEOUT_MS}`);
  }
}

/** Cheap bridge check for artifact writers running outside the serve process. */
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

function database(busyTimeoutMs = TRANSCRIPT_BUSY_TIMEOUT_MS): Database {
  const path = dbPath();
  if (db && dbOpenedPath === path) return db;
  if (db) {
    try {
      db.close();
    } catch {
      // ignore close errors when rebinding after PATHS.data changes (tests)
    }
    db = null;
    initialized = false;
  }
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  dbOpenedPath = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // The index has multiple process writers (serve plus managed harnesses).
  // Resuming a long thread can legitimately hold SQLite's single WAL writer
  // for several seconds, so short writes should wait rather than surface a
  // false failure after their primary data is already durable.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec("PRAGMA wal_autocheckpoint = 1000");
  startWalCheckpointTimer();
  return db;
}

/** Test helper: drop the open connection so the next call rebinds to PATHS.data. */
export function resetTranscriptIndexConnectionForTests(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  db = null;
  dbOpenedPath = null;
  initialized = false;
  directNextOffset.clear();
  pageTotalCache.clear();
  enqueued.clear();
  imports.clear();
}

function init(busyTimeoutMs = TRANSCRIPT_BUSY_TIMEOUT_MS) {
  if (initialized) return;
  const d = database(busyTimeoutMs);
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
      order_seq INTEGER,
      ts INTEGER,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transcript_messages_session_ts
      ON transcript_messages(session_id, ts);
    CREATE INDEX IF NOT EXISTS transcript_messages_path_offset
      ON transcript_messages(path, byte_offset);
    -- Artifact reconciliation looks rows up by their stable message id on
    -- every transcript page. Without this index each lookup scanned the whole
    -- transcript table (hundreds of MB on a busy install), stalling unrelated
    -- loopback requests and inflating the live ping display into seconds.
    CREATE INDEX IF NOT EXISTS transcript_messages_message_id
      ON transcript_messages(message_id);
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
  if (version < 5) {
    // Version 5 co-locates artifact metadata with transcript order so media
    // cards are read via JOIN — one data source, one rendering path.
    d.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        media TEXT NOT NULL DEFAULT 'image',
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        caption TEXT,
        alt TEXT,
        title TEXT,
        version INTEGER,
        source_path TEXT,
        source_mtime_ms REAL,
        refresh_json TEXT
      );
      CREATE INDEX IF NOT EXISTS artifacts_session_created
        ON artifacts(session_id, created_at);
      PRAGMA user_version = 5;
    `);
    // Seed from the durable JSON index so existing sessions JOIN correctly
    // without waiting for the next publish.
    for (const artifact of listAllArtifacts()) {
      upsertArtifactRow(d, artifact);
    }
  } else {
    d.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        media TEXT NOT NULL DEFAULT 'image',
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        caption TEXT,
        alt TEXT,
        title TEXT,
        version INTEGER,
        source_path TEXT,
        source_mtime_ms REAL,
        refresh_json TEXT
      );
      CREATE INDEX IF NOT EXISTS artifacts_session_created
        ON artifacts(session_id, created_at);
    `);
  }
  if (version < 6) {
    const columns = d.query<{ name: string }, []>("PRAGMA table_info(transcript_messages)").all();
    if (!columns.some((column) => column.name === "order_seq")) {
      d.exec("ALTER TABLE transcript_messages ADD COLUMN order_seq INTEGER");
    }
    d.exec(`
      WITH ranked AS (
        SELECT rowid AS rid,
               ROW_NUMBER() OVER (PARTITION BY path ORDER BY byte_offset ASC, rowid ASC) - 1 AS seq
          FROM transcript_messages
      )
      UPDATE transcript_messages
         SET order_seq = (SELECT seq FROM ranked WHERE ranked.rid = transcript_messages.rowid)
       WHERE order_seq IS NULL;
      CREATE INDEX IF NOT EXISTS transcript_messages_path_order
        ON transcript_messages(path, order_seq);
      PRAGMA user_version = 6;
    `);
  } else {
    d.exec(`CREATE INDEX IF NOT EXISTS transcript_messages_path_order
      ON transcript_messages(path, order_seq)`);
  }
  if (version < 7 || d.query<{ one: number }, []>(
    "SELECT 1 AS one FROM transcript_messages WHERE order_seq IS NULL LIMIT 1",
  ).get()) {
    // A pre-migration serve process may have appended rows while v6 was being
    // installed. Fold those stragglers into the same deterministic sequence.
    d.exec(`
      WITH ranked AS (
        SELECT rowid AS rid,
               ROW_NUMBER() OVER (PARTITION BY path ORDER BY byte_offset ASC, rowid ASC) - 1 AS seq
          FROM transcript_messages
      )
      UPDATE transcript_messages
         SET order_seq = (SELECT seq FROM ranked WHERE ranked.rid = transcript_messages.rowid)
       WHERE order_seq IS NULL;
      PRAGMA user_version = 7;
    `);
  }
  if (version < 8) {
    // Long-running managed harnesses can outlive a serve restart and still use
    // the pre-order_seq INSERT shape. A DB trigger keeps those concurrent old
    // writers compatible until their sessions naturally finish.
    d.exec(`
      CREATE TRIGGER IF NOT EXISTS transcript_messages_assign_order
      AFTER INSERT ON transcript_messages
      WHEN NEW.order_seq IS NULL
      BEGIN
        UPDATE transcript_messages
           SET order_seq = COALESCE((
             SELECT max(order_seq) + 1
               FROM transcript_messages
              WHERE path = NEW.path AND rowid <> NEW.rowid
           ), 0)
         WHERE rowid = NEW.rowid;
      END;
      WITH ranked AS (
        SELECT rowid AS rid,
               ROW_NUMBER() OVER (PARTITION BY path ORDER BY byte_offset ASC, rowid ASC) - 1 AS seq
          FROM transcript_messages
      )
      UPDATE transcript_messages
         SET order_seq = (SELECT seq FROM ranked WHERE ranked.rid = transcript_messages.rowid)
       WHERE order_seq IS NULL;
      PRAGMA user_version = 8;
    `);
  }
  if (version < 9) {
    // Final one-time import from the legacy blob catalog. From v9 onward the
    // catalog is not a transcript input: only an explicit display commit may
    // create a media placement. This keeps Shipped/gallery assets out of chat.
    for (const artifact of listAllArtifacts()) upsertArtifactRow(d, artifact);
    d.transaction(() => {
      // `lfg_ship` optimizes uploaded screenshots to this private temp naming
      // shape. The old manifest bridge incorrectly promoted those gallery-only
      // assets into chat. Remove the placement, not the artifact/file, so the
      // Shipped post keeps its media.
      d.query(`DELETE FROM transcript_messages_fts
        WHERE id IN (
          SELECT m.id FROM transcript_messages m
          JOIN artifacts a ON m.message_id = 'artifact-' || a.id
          WHERE a.source_path GLOB '/tmp/lfg-ship-????????????.webp'
        )`).run();
      d.query(`DELETE FROM transcript_messages
        WHERE id IN (
          SELECT m.id FROM transcript_messages m
          JOIN artifacts a ON m.message_id = 'artifact-' || a.id
          WHERE a.source_path GLOB '/tmp/lfg-ship-????????????.webp'
        )`).run();
      d.query(`DELETE FROM transcript_messages_fts
        WHERE id IN (
          SELECT m.id FROM transcript_messages m
          WHERE m.kind IN ('image', 'video', 'html')
            AND m.message_id LIKE 'artifact-%'
            AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = substr(m.message_id, 10))
        )`).run();
      d.query(`DELETE FROM transcript_messages
        WHERE kind IN ('image', 'video', 'html')
          AND message_id LIKE 'artifact-%'
          AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.id = substr(message_id, 10))`).run();
      d.exec("PRAGMA user_version = 9");
    }).immediate();
  }
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS transcript_artifact_message_unique
    ON transcript_messages(message_id)
    WHERE message_id LIKE 'artifact-%'`);
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

function rowMessage(row: IndexedMessageRow): SessionMsg | ImageArtifactMessage {
  const base: SessionMsg = {
    id: row.message_id || row.id,
    role: row.role,
    kind: row.kind,
    text: row.text,
    ts: row.ts,
  };
  if (row.kind !== "image" && row.kind !== "video" && row.kind !== "html") return base;

  // Prefer the JOIN payload so the page/live stream never needs a second
  // artifact-store pass to learn url/size/caption.
  if (row.artifact_id) {
    let refreshStatus: ImageArtifactMessage["refreshStatus"];
    let lastRefreshedAt: number | undefined;
    if (row.artifact_refresh_json) {
      try {
        const refresh = JSON.parse(row.artifact_refresh_json) as {
          status?: ImageArtifactMessage["refreshStatus"];
          lastSuccessAt?: number;
        };
        refreshStatus = refresh.status;
        lastRefreshedAt = refresh.lastSuccessAt;
      } catch {
        // ignore corrupt refresh blob; media still renders
      }
    }
    return {
      ...base,
      kind: (row.artifact_media as ImageArtifactMessage["kind"]) || row.kind,
      artifactId: row.artifact_id,
      url: `/api/artifacts/${encodeURIComponent(row.artifact_id)}`,
      name: row.artifact_name || row.text,
      mimeType: row.artifact_mime_type || "application/octet-stream",
      size: row.artifact_size ?? 0,
      caption: row.artifact_caption ?? undefined,
      alt: row.artifact_alt ?? undefined,
      title: row.artifact_title ?? undefined,
      version: row.artifact_version ?? undefined,
      // Updatable HTML cards surface at last content write.
      ts: row.artifact_updated_at ?? row.ts,
      lastRefreshedAt,
      refreshStatus,
    };
  }

  // Orphan media rows are excluded by the page queries. Never hydrate from a
  // second store here: that was the split-brain path that produced empty cards.
  return base;
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
  }).immediate();
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
    let orderSeq = nextOrderSeq(d, path);
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, order_seq, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        orderSeq++,
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
  }).immediate(rows);
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

function nextOrderSeq(d: Database, path: string): number {
  const max = d
    .query<{ max_seq: number | null }, [string]>(
      "SELECT max(order_seq) AS max_seq FROM transcript_messages WHERE path = ?",
    )
    .get(path)?.max_seq;
  return (max ?? -1) + 1;
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
    let orderSeq = nextOrderSeq(d, key);
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, order_seq, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        orderSeq++,
        row.msg.ts,
        row.msg.role,
        row.msg.kind,
        row.text,
      );
      insertedRows += Number(result.changes ?? 0);
      ftsStmt.run(row.id, sessionId, row.text, row.id);
    }
    return insertedRows;
  }).immediate(rows);
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

// Seed the synthetic per-session read model (`lfg://session/<id>`) from history
// that was indexed under a real FILE path. Two cases:
//   - claude: legacy sessions indexed by their native ~/.claude JSONL before the
//     direct-SDK aisdk harness existed, keyed under the file path with the lfg
//     session id (sourceSessionId defaults to sessionId).
//   - codex: the rollout JSONL is tailed under the native threadId, so a session
//     resumed under a fresh control-plane key must pull from that threadId
//     (pass it as sourceSessionId).
// A resumed harness serves only the synthetic key, and `indexedMessagePage`
// filters (WHERE path = ?), so without this the pane renders empty. Copying the
// rows under the synthetic key makes the full history visible; new turns then
// append after them via indexSessionMessagesDirect. No-op when the synthetic key
// already has rows (working/new sessions) or when there is no file-path history,
// so it can never regress a healthy session.
export function reindexFileHistoryUnderSessionKey(
  sessionId: string,
  sourceSessionId: string = sessionId,
): number {
  init();
  const key = sessionIndexKey(sessionId);
  const d = database();
  if (d.query("SELECT 1 FROM transcript_messages WHERE path = ? LIMIT 1").get(key)) return 0;
  const src = d
    .query<
      { message_id: string | null; role: string; kind: string; ts: number; text: string },
      [string]
    >(
      `SELECT message_id, role, kind, ts, text
         FROM transcript_messages
        WHERE session_id = ? AND path NOT LIKE 'lfg://%'
        ORDER BY order_seq ASC, id ASC`,
    )
    .all(sourceSessionId);
  if (!src.length) return 0;
  let seq = 0;
  const inserted = d.transaction((rows: typeof src) => {
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, order_seq, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ftsStmt = d.query(`
      INSERT INTO transcript_messages_fts (id, session_id, text)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM transcript_messages_fts WHERE id = ?)
    `);
    let n = 0;
    for (const r of rows) {
      const id = `${key}\0${r.message_id ?? String(seq)}\0${seq}`;
      const result = msgStmt.run(id, sessionId, key, r.message_id, seq, seq, r.ts, r.role, r.kind, r.text);
      n += Number(result.changes ?? 0);
      ftsStmt.run(id, sessionId, r.text, id);
      seq++;
    }
    return n;
  }).immediate(src);
  directNextOffset.set(key, seq);
  pageTotalCache.delete(key);
  return inserted;
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
    }).immediate();
  }

  if (st.size < cursor) {
    d.transaction(() => {
      d.query("DELETE FROM transcript_messages_fts WHERE id IN (SELECT id FROM transcript_messages WHERE path = ?)")
        .run(path);
      d.query("DELETE FROM transcript_messages WHERE path = ?").run(path);
      d.query("DELETE FROM transcript_index_cursors WHERE path = ?").run(path);
    }).immediate();
    cursor = 0;
  }

  const file = Bun.file(path);
  const decoder = new TextDecoder();
  let indexed = 0;
  let committed = cursor;

  const insert = d.transaction((rows: Array<{ id: string; msg: SessionMsg; text: string; offset: number }>) => {
    let orderSeq = nextOrderSeq(d, path);
    const msgStmt = d.query(`
      INSERT OR IGNORE INTO transcript_messages
        (id, session_id, path, message_id, byte_offset, order_seq, ts, role, kind, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        orderSeq++,
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
    insert.immediate(rows);
    if (advance < scanEnd || scanEnd === 0) break;
  }

  if (committed === st.size) insert.immediate([]);
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
        SELECT ${ARTIFACT_MESSAGE_SELECT}
        FROM transcript_messages m
        LEFT JOIN artifacts a
          ON a.id = CASE
            WHEN m.message_id LIKE 'artifact-%' THEN substr(m.message_id, 10)
            ELSE NULL
          END
        WHERE m.path = ? AND m.order_seq < ?
          AND (
            m.kind NOT IN ('image', 'video', 'html')
            OR m.message_id NOT LIKE 'artifact-%'
            OR a.id IS NOT NULL
          )
        ORDER BY m.order_seq DESC, m.rowid DESC
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
  const nextBefore = oldest.order_seq > 0 ? oldest.order_seq : null;
  const totalKey = isSessionIndexKey(path)
    ? (d
        .query<{ max_offset: number | null }, [string]>(
          "SELECT max(order_seq) AS max_offset FROM transcript_messages WHERE path = ?",
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
          SELECT m.rowid AS rowid, ${ARTIFACT_MESSAGE_SELECT}
          FROM transcript_messages m
          LEFT JOIN artifacts a
            ON a.id = CASE
              WHEN m.message_id LIKE 'artifact-%' THEN substr(m.message_id, 10)
              ELSE NULL
            END
          WHERE m.path = ? AND m.rowid > ?
            AND (
              m.kind NOT IN ('image', 'video', 'html')
              OR m.message_id NOT LIKE 'artifact-%'
              OR a.id IS NOT NULL
            )
          ORDER BY m.rowid ASC
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
      SELECT m.session_id, m.path, m.role, m.kind, m.ts, m.text, m.order_seq AS byte_offset
      FROM transcript_messages_fts f
      JOIN transcript_messages m ON m.id = f.id
      WHERE m.session_id = ? AND transcript_messages_fts MATCH ?
      ORDER BY COALESCE(m.ts, 0) DESC, m.order_seq DESC
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
      SELECT m.session_id, m.path, m.role, m.kind, m.ts, m.text, m.order_seq AS byte_offset
      FROM transcript_messages_fts f
      JOIN transcript_messages m ON m.id = f.id
      WHERE transcript_messages_fts MATCH ?
      ORDER BY COALESCE(m.ts, 0) DESC, m.order_seq DESC
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
