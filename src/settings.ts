import { mkdirSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import { join } from "node:path";
import {
  MAX_CONCURRENT_AGENTS_LIMIT,
  maxConcurrentAgents,
} from "./subagent-limiter.ts";

export type GlobalSettings = {
  timeZone: string;
  maxConcurrentAgents: number;
};

const LEGACY_SETTINGS_PATH = join(PATHS.data, "settings.json");
const SETTINGS_DB_PATH = join(PATHS.data, "lfg.sqlite");
export const DEFAULT_TIME_ZONE = "Asia/Hong_Kong";
let db: Database | null = null;

function envTimeZone(): string {
  return process.env.LFG_SCHED_TZ || DEFAULT_TIME_ZONE;
}

export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function sanitize(input: Partial<GlobalSettings> | null | undefined): GlobalSettings {
  const timeZone = typeof input?.timeZone === "string" && validTimeZone(input.timeZone)
    ? input.timeZone
    : envTimeZone();
  const requestedMax = Number(input?.maxConcurrentAgents);
  const maxAgents = Number.isInteger(requestedMax) && requestedMax > 0
    ? Math.min(requestedMax, MAX_CONCURRENT_AGENTS_LIMIT)
    : maxConcurrentAgents();
  return { timeZone, maxConcurrentAgents: maxAgents };
}

function settingsDb(): Database {
  if (db) return db;
  mkdirSync(PATHS.data, { recursive: true });
  const opened = new Database(SETTINGS_DB_PATH, { create: true });
  opened.exec("PRAGMA journal_mode = WAL");
  opened.exec("PRAGMA busy_timeout = 5000");
  opened.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrated = opened
    .query<{ found: number }, []>(
      "SELECT 1 AS found FROM settings_migrations WHERE name = 'legacy-settings-json-v1'",
    )
    .get();
  if (!migrated) {
    let legacy: Partial<GlobalSettings> | null = null;
    try {
      legacy = JSON.parse(readFileSync(LEGACY_SETTINGS_PATH, "utf8")) as Partial<GlobalSettings>;
    } catch {}
    const initial = sanitize(legacy);
    const write = opened.query(
      "INSERT OR IGNORE INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)",
    );
    const migrate = opened.transaction(() => {
      const now = Date.now();
      write.run("timeZone", JSON.stringify(initial.timeZone), now);
      write.run("maxConcurrentAgents", JSON.stringify(initial.maxConcurrentAgents), now);
      opened
        .query("INSERT INTO settings_migrations (name, applied_at) VALUES (?, ?)")
        .run("legacy-settings-json-v1", now);
    });
    migrate();
  }
  db = opened;
  return opened;
}

function readStoredSettings(): Partial<GlobalSettings> {
  const rows = settingsDb()
    .query<{ key: string; value_json: string }, []>("SELECT key, value_json FROM app_settings")
    .all();
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value_json);
    } catch {}
  }
  return stored as Partial<GlobalSettings>;
}

export function getGlobalSettingsSync(): GlobalSettings {
  return sanitize(readStoredSettings());
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  return getGlobalSettingsSync();
}

export async function setGlobalSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const current = getGlobalSettingsSync();
  const next = sanitize({ ...current, ...patch });
  const database = settingsDb();
  const write = database.query(`
    INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  database.transaction(() => {
    const now = Date.now();
    write.run("timeZone", JSON.stringify(next.timeZone), now);
    write.run("maxConcurrentAgents", JSON.stringify(next.maxConcurrentAgents), now);
  })();
  return next;
}
