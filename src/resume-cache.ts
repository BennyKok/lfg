// Durable cache + query layer for the "resume a session" picker.
//
// listResumable() used to readdir the whole ~/.claude/projects tree and re-read
// each candidate transcript's title/cwd/last-message on EVERY request. That is
// fine for "newest 20" but makes search / filtering across the full history
// impractical. This module persists the enriched roster in a small SQLite DB so
// repeat loads are instant and search/filter/facets run as indexed SQL.
//
// The scan/enrich orchestration lives in sessions.ts (it owns the transcript
// helpers); this module owns only persistence + querying.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { PATHS } from "./config";
import type { ResumableSession } from "./sessions";

// One cache row == a ResumableSession plus the fingerprint fields used to decide
// whether an entry needs re-enriching on the next scan.
export type ResumableCacheRow = ResumableSession & {
  path: string | null;
  mtimeMs: number;
};

export type ResumableQuery = {
  limit?: number;
  offset?: number;
  // Space-separated terms; every term must appear (AND) in title / last message
  // / project (case-insensitive substring).
  search?: string;
  // "claude" | "codex" — omit for all engines.
  agent?: string;
  // Exact project match — omit for all projects.
  project?: string;
  // Currently-live session ids to hide (they belong in the live list, not here).
  excludeIds?: Set<string>;
};

export type ResumableFacets = {
  agents: Array<{ agent: string; count: number }>;
  projects: Array<{ project: string; count: number }>;
};

export type ResumableQueryResult = {
  sessions: ResumableSession[];
  total: number;
  facets: ResumableFacets;
};

type Row = {
  session_id: string;
  cwd: string | null;
  project: string;
  title: string;
  last_user_text: string | null;
  last_activity_at: number | null;
  agent: string;
  path: string | null;
  mtime_ms: number;
};

const DB_PATH = join(PATHS.data, "resume-cache.sqlite");

let db: Database | null = null;
let initialized = false;

function database(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 2500");
  return db;
}

function init(): Database {
  const d = database();
  if (initialized) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS resumable_sessions (
      session_id TEXT PRIMARY KEY,
      cwd TEXT,
      project TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      last_user_text TEXT,
      last_activity_at INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      path TEXT,
      mtime_ms REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS resumable_sessions_activity
      ON resumable_sessions(last_activity_at DESC);
    CREATE INDEX IF NOT EXISTS resumable_sessions_project
      ON resumable_sessions(project);
  `);
  initialized = true;
  return d;
}

function toSession(row: Row): ResumableSession {
  return {
    sessionId: row.session_id,
    cwd: row.cwd,
    project: row.project,
    title: row.title,
    lastActivityAt: row.last_activity_at,
    lastUserText: row.last_user_text,
    agent: (row.agent === "codex" ? "codex" : "claude") as ResumableSession["agent"],
  };
}

// The (id -> fingerprint) map the scanner diffs against so it only pays the
// enrich cost for transcripts that are new or have grown since last time.
export function cachedFingerprints(): Map<string, { mtimeMs: number; path: string | null }> {
  const d = init();
  const rows = d
    .query<{ session_id: string; mtime_ms: number; path: string | null }, []>(
      "SELECT session_id, mtime_ms, path FROM resumable_sessions",
    )
    .all();
  const out = new Map<string, { mtimeMs: number; path: string | null }>();
  for (const r of rows) out.set(r.session_id, { mtimeMs: r.mtime_ms, path: r.path });
  return out;
}

export function upsertResumableRows(rows: ResumableCacheRow[]): void {
  if (!rows.length) return;
  const d = init();
  const stmt = d.query(`
    INSERT INTO resumable_sessions
      (session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = excluded.cwd,
      project = excluded.project,
      title = excluded.title,
      last_user_text = excluded.last_user_text,
      last_activity_at = excluded.last_activity_at,
      agent = excluded.agent,
      path = excluded.path,
      mtime_ms = excluded.mtime_ms
  `);
  d.transaction((batch: ResumableCacheRow[]) => {
    for (const r of batch) {
      stmt.run(
        r.sessionId,
        r.cwd,
        r.project || "",
        r.title || "",
        r.lastUserText,
        r.lastActivityAt,
        r.agent,
        r.path,
        r.mtimeMs,
      );
    }
  })(rows);
}

// Drop cache rows whose transcripts no longer exist so a deleted / rotated
// session stops showing up in the picker.
export function pruneResumableExcept(keep: Set<string>): void {
  const d = init();
  const existing = d
    .query<{ session_id: string }, []>("SELECT session_id FROM resumable_sessions")
    .all();
  const stale = existing.filter((r) => !keep.has(r.session_id)).map((r) => r.session_id);
  if (!stale.length) return;
  const del = d.query("DELETE FROM resumable_sessions WHERE session_id = ?");
  d.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  })(stale);
}

export function getCachedResumableSession(sessionId: string): ResumableSession | null {
  const d = init();
  const row = d
    .query<Row, [string]>(`
      SELECT session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms
      FROM resumable_sessions
      WHERE session_id = ?
    `)
    .get(sessionId);
  return row ? toSession(row) : null;
}

// Turn "foo bar" into an AND of case-insensitive substring predicates over the
// searchable columns, plus the bound params. Empty query -> no predicate.
function searchClause(search: string | undefined): { sql: string; params: string[] } {
  const terms = (search ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return { sql: "", params: [] };
  const params: string[] = [];
  const clauses = terms.map((term) => {
    const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like, like);
    return (
      "(LOWER(title) LIKE ? ESCAPE '\\'" +
      " OR LOWER(COALESCE(last_user_text,'')) LIKE ? ESCAPE '\\'" +
      " OR LOWER(project) LIKE ? ESCAPE '\\')"
    );
  });
  return { sql: clauses.join(" AND "), params };
}

function excludeClause(excludeIds: Set<string> | undefined): { sql: string; params: string[] } {
  const ids = excludeIds ? [...excludeIds] : [];
  if (!ids.length) return { sql: "", params: [] };
  return { sql: `session_id NOT IN (${ids.map(() => "?").join(",")})`, params: ids };
}

export function queryResumableCache(opts: ResumableQuery = {}): ResumableQueryResult {
  const d = init();
  const limit = Math.max(1, Math.min(200, opts.limit ?? 30));
  const offset = Math.max(0, opts.offset ?? 0);

  const search = searchClause(opts.search);
  const exclude = excludeClause(opts.excludeIds);

  // Facets ignore the agent/project selection (so chip counts stay stable while
  // you toggle them) but DO respect search + the live-session exclusion.
  const facetWhere: string[] = [];
  const facetParams: (string | number)[] = [];
  if (search.sql) {
    facetWhere.push(search.sql);
    facetParams.push(...search.params);
  }
  if (exclude.sql) {
    facetWhere.push(exclude.sql);
    facetParams.push(...exclude.params);
  }
  const facetWhereSql = facetWhere.length ? `WHERE ${facetWhere.join(" AND ")}` : "";

  const agentFacet = d
    .query<{ agent: string; count: number }, (string | number)[]>(
      `SELECT agent, COUNT(*) AS count FROM resumable_sessions ${facetWhereSql} GROUP BY agent ORDER BY count DESC`,
    )
    .all(...facetParams);
  const projectFacet = d
    .query<{ project: string; count: number }, (string | number)[]>(
      `SELECT project, COUNT(*) AS count FROM resumable_sessions ${facetWhereSql} GROUP BY project ORDER BY count DESC, project ASC`,
    )
    .all(...facetParams);

  // The visible page respects every filter.
  const where = [...facetWhere];
  const params = [...facetParams];
  if (opts.agent) {
    where.push("agent = ?");
    params.push(opts.agent);
  }
  if (opts.project) {
    where.push("project = ?");
    params.push(opts.project);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total =
    d
      .query<{ count: number }, (string | number)[]>(
        `SELECT COUNT(*) AS count FROM resumable_sessions ${whereSql}`,
      )
      .get(...params)?.count ?? 0;

  const rows = d
    .query<Row, (string | number)[]>(`
      SELECT session_id, cwd, project, title, last_user_text, last_activity_at, agent, path, mtime_ms
      FROM resumable_sessions
      ${whereSql}
      ORDER BY last_activity_at IS NULL, last_activity_at DESC, session_id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);

  return {
    sessions: rows.map(toSession),
    total,
    facets: {
      agents: agentFacet.map((r) => ({ agent: r.agent, count: r.count })),
      projects: projectFacet
        .filter((r) => r.project)
        .map((r) => ({ project: r.project, count: r.count })),
    },
  };
}
