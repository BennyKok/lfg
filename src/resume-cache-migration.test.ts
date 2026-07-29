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

    const columns = db.query<{ name: string }, []>("PRAGMA table_info(resumable_sessions)").all();
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "backend",
      "resume_handle",
      "model",
      "assigned_user",
      "managed",
    ]));
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1);
    db.close();
  });
});
