import { mkdirSync, readFileSync } from "node:fs";
import { PATHS } from "./config.ts";
import { join } from "node:path";

export type GlobalSettings = {
  timeZone: string;
};

const SETTINGS_PATH = join(PATHS.data, "settings.json");
export const DEFAULT_TIME_ZONE = "Asia/Hong_Kong";

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
  return { timeZone };
}

export function getGlobalSettingsSync(): GlobalSettings {
  try {
    return sanitize(JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Partial<GlobalSettings>);
  } catch {
    return sanitize(null);
  }
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  return getGlobalSettingsSync();
}

export async function setGlobalSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
  const current = getGlobalSettingsSync();
  const next = sanitize({ ...current, ...patch });
  mkdirSync(PATHS.data, { recursive: true });
  await Bun.write(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
