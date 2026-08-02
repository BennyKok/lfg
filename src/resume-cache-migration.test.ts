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
        ('other-session', 'claude', 0);
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
    ).all().map((row) => row.session_id)).toEqual(["cursor-session", "grok-session"]);
    expect(db.query<{ backend: string | null }, []>(
      "SELECT backend FROM resumable_sessions WHERE session_id = 'grok-session'",
    ).get()?.backend).toBeNull();
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4);
    db.close();
  });
});
