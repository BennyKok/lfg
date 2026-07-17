import { mkdirSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { PATHS } from "./config.ts";
import { join } from "node:path";

export type GlobalSettings = {
  timeZone: string;
  // Hard ceiling on total LIVE agents (main + subagent + fork + voice), 0 =
  // unlimited.
  maxLiveAgents: number;
  // Drain switch: when true, refuse to activate any new agent (create / cold
  // resume / fork). In-flight agents keep running and can still be messaged.
  agentsPaused: boolean;
};

// A soft admission ceiling backed by the systemd slice's hard memory bound.
export const MAX_LIVE_AGENTS_LIMIT = 64;
// On by default: live agents are the memory-intensive ones, so we cap them out
// of the box. 0 means unlimited (opt-out); anything unset falls back to this.
export const DEFAULT_MAX_LIVE_AGENTS = 16;

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
  const requestedLive = Number(input?.maxLiveAgents);
  const maxLiveAgents = Number.isInteger(requestedLive) && requestedLive >= 0
    ? Math.min(requestedLive, MAX_LIVE_AGENTS_LIMIT)
    : DEFAULT_MAX_LIVE_AGENTS;
  const agentsPaused = input?.agentsPaused === true;
  return { timeZone, maxLiveAgents, agentsPaused };
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
      write.run("maxLiveAgents", JSON.stringify(initial.maxLiveAgents), now);
      write.run("agentsPaused", JSON.stringify(initial.agentsPaused), now);
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
    write.run("maxLiveAgents", JSON.stringify(next.maxLiveAgents), now);
    write.run("agentsPaused", JSON.stringify(next.agentsPaused), now);
  })();
  return next;
}
