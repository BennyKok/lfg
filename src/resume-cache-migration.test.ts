import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("resume cache migration", () => {
  test("adds durable managed-session resume metadata to an existing cache", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-resume-migration-"));
    const db = new Database(join(root, "cache.sqlite"), { create: true });
    db.exec(`
      CREATE TABLE resumable_sessions (
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
    `);
    const sql = readFileSync(
      new URL("./migrations/resume-cache/001_managed_session_resume.sql", import.meta.url),
      "utf8",
    );
    db.exec(sql);
    const historicalSql = readFileSync(
      new URL("./migrations/resume-cache/002_historical_sessions.sql", import.meta.url),
      "utf8",
    );
    db.exec(historicalSql);
    db.exec(`
      INSERT INTO resumable_sessions
        (session_id, agent, resumable)
      VALUES
        ('grok-session', 'grok', 0),
        ('cursor-session', 'cursor', 0),
        ('other-session', 'claude', 0),
        ('managed-session', 'claude', 1);
    `);
    const nativeTuiSql = readFileSync(
      new URL("./migrations/resume-cache/003_native_tui_resume.sql", import.meta.url),
      "utf8",
    );
    db.exec(nativeTuiSql);
    db.exec(`
      UPDATE resumable_sessions
      SET backend = 'aisdk', model = 'opus', resume_handle = session_id, managed = 1
      WHERE session_id = 'grok-session';
    `);
    const identitySql = readFileSync(
      new URL("./migrations/resume-cache/004_repair_backend_identity.sql", import.meta.url),
      "utf8",
    );
    db.exec(identitySql);
    db.exec(`
      UPDATE resumable_sessions
      SET mtime_ms = 42
      WHERE session_id IN ('grok-session', 'cursor-session', 'other-session', 'managed-session');
      UPDATE resumable_sessions
      SET backend = 'aisdk', resume_handle = session_id, managed = 1
      WHERE session_id = 'managed-session';
    `);
    const historicalTitleSql = readFileSync(
      new URL("./migrations/resume-cache/005_refresh_historical_titles.sql", import.meta.url),
      "utf8",
    );
    db.exec(historicalTitleSql);
    db.exec(`
      UPDATE resumable_sessions SET mtime_ms = 42;
      UPDATE resumable_sessions
      SET title = '=== LFG RUNTIME CONTRACT (capability version 2026-08-05.2) ==='
      WHERE session_id = 'other-session';
      UPDATE resumable_sessions
      SET title = 'Fix the resume sheet',
          last_user_text = '=== LFG RUNTIME CONTRACT (capability version 2026-08-05.2) ==='
      WHERE session_id = 'cursor-session';
    `);
    const contractTitleSql = readFileSync(
      new URL("./migrations/resume-cache/006_strip_runtime_contract_titles.sql", import.meta.url),
      "utf8",
    );
    db.exec(contractTitleSql);

    const columns = db.query<{ name: string }, []>("PRAGMA table_info(resumable_sessions)").all();
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "backend",
      "resume_handle",
      "model",
      "assigned_user",
      "managed",
      "resumable",
    ]));
    expect(db.query<{ session_id: string }, []>(
      "SELECT session_id FROM resumable_sessions WHERE resumable = 1 ORDER BY session_id",
    ).all().map((row) => row.session_id)).toEqual([
      "cursor-session",
      "grok-session",
      "managed-session",
    ]);
    expect(db.query<{ backend: string | null }, []>(
      "SELECT backend FROM resumable_sessions WHERE session_id = 'grok-session'",
    ).get()?.backend).toBeNull();
    // Contract-titled rows (title or preview) are re-enriched; clean rows keep
    // their fingerprint so the upgrade doesn't rescan the whole history.
    expect(db.query<{ mtime_ms: number }, []>(
      "SELECT mtime_ms FROM resumable_sessions WHERE session_id = 'other-session'",
    ).get()?.mtime_ms).toBe(-1);
    expect(db.query<{ mtime_ms: number }, []>(
      "SELECT mtime_ms FROM resumable_sessions WHERE session_id = 'cursor-session'",
    ).get()?.mtime_ms).toBe(-1);
    expect(db.query<{ mtime_ms: number }, []>(
      "SELECT mtime_ms FROM resumable_sessions WHERE session_id = 'managed-session'",
    ).get()?.mtime_ms).toBe(42);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(6);
    db.close();
  });
});
