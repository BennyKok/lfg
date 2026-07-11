import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import type { CodingAgentKind } from "./coding-agents.ts";
import { getGlobalSettingsSync } from "./settings.ts";

type ProviderKey = CodingAgentKind;

export type DiscoveredModelProvider = {
  key: ProviderKey;
  ok: boolean;
  command?: string[];
  models: string[];
  labels?: Record<string, string>;
  error?: string;
  refreshedAt: number;
  durationMs: number;
};

export type ModelDiscoveryCache = {
  version: 1;
  refreshedAt: number;
  schedule: string;
  timeZone: string;
  lastScheduledRunAt?: number;
  providers: Partial<Record<ProviderKey, DiscoveredModelProvider>>;
};

const CACHE_PATH = join(PATHS.data, "model-catalog.json");
const DEFAULT_REFRESH_CRON = "0 8 * * *";
const DEFAULT_TIMEOUT_MS = 20_000;
const MODEL_ID_RE = /^[A-Za-z0-9_.:/\-[\],=]+$/;
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function schedulerTimeZone(): string {
  return process.env.LFG_MODEL_REFRESH_TZ || getGlobalSettingsSync().timeZone;
}

function refreshCron(): string {
  return process.env.LFG_MODEL_REFRESH_CRON || DEFAULT_REFRESH_CRON;
}

function which(name: string, extra: string[] = []): string | null {
  try {
    const found = Bun.which(name);
    if (found) return found;
  } catch {}
  for (const candidate of extra) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function userHome(): string {
  return process.env.HOME || homedir();
}

function codexPath(): string | null {
  if (process.env.LFG_CODEX_PATH) return process.env.LFG_CODEX_PATH;
  const home = userHome();
  return which("codex", [`${home}/.bun/bin/codex`, `${home}/.local/bin/codex`, "/usr/local/bin/codex"]);
}

function grokPath(): string | null {
  if (process.env.LFG_GROK_PATH) return process.env.LFG_GROK_PATH;
  const home = userHome();
  // Prefer the native ~/.grok/bin binary over the npm/bun node trampoline.
  return which("grok", [
    `${home}/.grok/bin/grok`,
    `${home}/.local/bin/grok`,
    `${home}/.bun/bin/grok`,
    `${home}/.grok/downloads/grok-linux-x86_64`,
    "/usr/local/bin/grok",
  ]);
}

/** Models last fetched by the Grok CLI into ~/.grok/models_cache.json (auth-gated). */
function readGrokModelsCache(): { models: string[]; labels: Record<string, string> } {
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  try {
    const raw = JSON.parse(
      readFileSync(join(userHome(), ".grok", "models_cache.json"), "utf8"),
    ) as {
      models?: Record<
        string,
        { info?: { id?: unknown; name?: unknown; hidden?: unknown; supported_in_api?: unknown } }
      >;
    };
    for (const [key, entry] of Object.entries(raw.models ?? {})) {
      const info = entry?.info ?? {};
      if (info.hidden === true) continue;
      if (info.supported_in_api === false) continue;
      const id = cleanId(typeof info.id === "string" ? info.id : key);
      addModel(ids, labels, id, typeof info.name === "string" ? info.name : undefined);
    }
  } catch {
    // Cache is optional — discovery still works from `grok models`.
  }
  return { models: ids, labels };
}

function cursorPath(): string | null {
  if (process.env.LFG_CURSOR_PATH) return process.env.LFG_CURSOR_PATH;
  const home = userHome();
  return which("cursor-agent", [`${home}/.local/bin/cursor-agent`, `${home}/.bun/bin/cursor-agent`, "/usr/local/bin/cursor-agent"]);
}

function opencodePath(): string | null {
  if (process.env.LFG_OPENCODE_PATH) return process.env.LFG_OPENCODE_PATH;
  return which("opencode", [join(PATHS.root, "node_modules", ".bin", "opencode")]);
}

function hermesPath(): string | null {
  if (process.env.LFG_HERMES_PATH) return process.env.LFG_HERMES_PATH;
  const home = userHome();
  return which("hermes", [`${home}/.local/bin/hermes`, `${home}/.bun/bin/hermes`, "/usr/local/bin/hermes"]);
}

function commandFor(key: ProviderKey): string[] | null {
  if (key === "codex" || key === "codex-aisdk") {
    const bin = codexPath();
    return bin ? [bin, "debug", "models"] : null;
  }
  if (key === "grok") {
    const bin = grokPath();
    return bin ? [bin, "models"] : null;
  }
  if (key === "cursor") {
    const bin = cursorPath();
    return bin ? [bin, "models"] : null;
  }
  if (key === "opencode") {
    const bin = opencodePath();
    return bin ? [bin, "models"] : null;
  }
  if (key === "hermes") {
    const bin = hermesPath();
    return bin ? [bin, "models"] : null;
  }
  return null;
}

function cleanText(text: string): string {
  return text.replace(ANSI_RE, "");
}

function cleanId(value: string): string | null {
  const id = value.trim();
  if (!id || id.length > 160 || /\s/.test(id)) return null;
  return MODEL_ID_RE.test(id) ? id : null;
}

function addModel(
  ids: string[],
  labels: Record<string, string>,
  id: string | null,
  label?: string,
) {
  if (!id || ids.includes(id)) return;
  ids.push(id);
  const cleanLabel = label?.trim();
  if (cleanLabel && cleanLabel !== id) labels[id] = cleanLabel;
}

function parseCodexModels(text: string): { models: string[]; labels: Record<string, string> } {
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  const parsed = JSON.parse(text) as { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }> };
  for (const item of parsed.models ?? []) {
    if (typeof item.slug !== "string") continue;
    if (item.visibility === "hidden" || item.visibility === "internal") continue;
    addModel(ids, labels, cleanId(item.slug), typeof item.display_name === "string" ? item.display_name : undefined);
  }
  return { models: ids, labels };
}

function parseBulletModels(text: string): { models: string[]; labels: Record<string, string> } {
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  for (const line of cleanText(text).split("\n")) {
    const match = line.match(/^\s*[-*]\s+([^\s(]+)(?:\s+\(([^)]+)\))?/);
    if (!match) continue;
    const label = match[2]?.trim();
    // `grok models` marks the default with "(default)" — not a display name.
    addModel(ids, labels, cleanId(match[1] ?? ""), label && label.toLowerCase() !== "default" ? label : undefined);
  }
  return { models: ids, labels };
}

function parseDashListModels(text: string): { models: string[]; labels: Record<string, string> } {
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  for (const line of cleanText(text).split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9_.:/\-[\],=]+)\s+-\s+(.+?)\s*$/);
    if (!match) continue;
    addModel(ids, labels, cleanId(match[1] ?? ""), match[2]);
  }
  return { models: ids, labels };
}

function parsePlainModelLines(text: string): { models: string[]; labels: Record<string, string> } {
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  for (const raw of cleanText(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("Usage:") || line.startsWith("Available ")) continue;
    addModel(ids, labels, cleanId(line));
  }
  return { models: ids, labels };
}

function parseModels(key: ProviderKey, text: string): { models: string[]; labels: Record<string, string> } {
  if (key === "codex" || key === "codex-aisdk") return parseCodexModels(text);
  if (key === "grok") return parseBulletModels(text);
  if (key === "cursor") return parseDashListModels(text);
  if (key === "opencode") return parsePlainModelLines(text);
  if (key === "hermes") {
    const dash = parseDashListModels(text);
    return dash.models.length ? dash : parsePlainModelLines(text);
  }
  return { models: [], labels: {} };
}

async function runCommand(argv: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {}
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]);
    return { ok: exitCode === 0 && !timedOut, stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function discoverProvider(key: ProviderKey): Promise<DiscoveredModelProvider> {
  const started = performance.now();
  const refreshedAt = Date.now();
  const command = commandFor(key);
  if (!command) {
    return {
      key,
      ok: false,
      models: [],
      error: key === "claude" || key === "aisdk" ? "no model-list command exposed by this harness" : "harness CLI not found",
      refreshedAt,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
  }
  try {
    const out = await runCommand(command);
    if (!out.ok) {
      if (key === "grok") {
        const cached = readGrokModelsCache();
        if (cached.models.length) {
          return {
            key,
            ok: true,
            command,
            models: cached.models,
            labels: Object.keys(cached.labels).length ? cached.labels : undefined,
            refreshedAt,
            durationMs: Math.round((performance.now() - started) * 1000) / 1000,
          };
        }
      }
      return {
        key,
        ok: false,
        command,
        models: [],
        error: out.timedOut
          ? `timed out after ${DEFAULT_TIMEOUT_MS}ms`
          : (out.stderr || out.stdout || `exit ${out.exitCode}`).trim().slice(0, 500),
        refreshedAt,
        durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      };
    }
    const parsed = parseModels(key, out.stdout);
    // Unauthenticated `grok models` only prints the built-in default. Merge the
    // CLI's on-disk models_cache (last successful auth fetch) so Composer etc.
    // stay visible in the picker.
    if (key === "grok") {
      const cached = readGrokModelsCache();
      for (const id of cached.models) addModel(parsed.models, parsed.labels, id, cached.labels[id]);
    }
    return {
      key,
      ok: true,
      command,
      models: parsed.models,
      labels: Object.keys(parsed.labels).length ? parsed.labels : undefined,
      refreshedAt,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
  } catch (e) {
    return {
      key,
      ok: false,
      command,
      models: [],
      error: e instanceof Error ? e.message : String(e),
      refreshedAt,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    };
  }
}

function readCacheFile(): ModelDiscoveryCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as ModelDiscoveryCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: ModelDiscoveryCache): Promise<void> {
  mkdirSync(PATHS.data, { recursive: true });
  await Bun.write(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function readModelDiscoveryCacheSync(): ModelDiscoveryCache | null {
  return readCacheFile();
}

export function discoveredModelIdsByProviderSync(): Partial<Record<ProviderKey, string[]>> {
  const cache = readCacheFile();
  const out: Partial<Record<ProviderKey, string[]>> = {};
  if (!cache) return out;
  for (const [key, provider] of Object.entries(cache.providers) as Array<[ProviderKey, DiscoveredModelProvider | undefined]>) {
    if (provider?.ok && provider.models.length) out[key] = provider.models;
  }
  return out;
}

export async function refreshModelCatalog(input: {
  reason?: string;
  scheduledRunAt?: number;
  onLog?: (line: string) => void;
} = {}): Promise<ModelDiscoveryCache> {
  const started = Date.now();
  const onLog = input.onLog ?? (() => {});
  onLog(`[models] refreshing catalog${input.reason ? ` (${input.reason})` : ""}`);
  const prior = readCacheFile();
  const keys: ProviderKey[] = ["claude", "aisdk", "codex", "grok", "cursor", "opencode"];
  const results = await Promise.all(keys.map((key) => discoverProvider(key)));
  const providers: Partial<Record<ProviderKey, DiscoveredModelProvider>> = {};
  for (const result of results) {
    providers[result.key] = result;
    const count = result.ok ? result.models.length : 0;
    onLog(`[models] ${result.key}: ${result.ok ? `${count} models` : result.error || "failed"}`);
  }
  if (providers.codex) {
    providers["codex-aisdk"] = { ...providers.codex, key: "codex-aisdk" };
  }
  const cache: ModelDiscoveryCache = {
    version: 1,
    refreshedAt: Date.now(),
    schedule: refreshCron(),
    timeZone: schedulerTimeZone(),
    lastScheduledRunAt: input.scheduledRunAt ?? prior?.lastScheduledRunAt,
    providers,
  };
  await writeCache(cache);
  onLog(`[models] catalog refreshed in ${Date.now() - started}ms`);
  return cache;
}

function zonedParts(d: Date, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    minute: parseInt(parts.minute as string, 10),
    hour: parseInt(parts.hour as string, 10),
    dom: parseInt(parts.day as string, 10),
    month: parseInt(parts.month as string, 10),
    dow: DOW[parts.weekday as string] ?? 0,
  };
}

function fieldMatch(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10) || 1;
      if (range === "*") {
        if (value % step === 0) return true;
        continue;
      }
      const [lo, hi] = range.split("-").map((n) => parseInt(n, 10));
      if (!Number.isNaN(lo)) {
        const top = Number.isNaN(hi) ? lo : hi;
        for (let v = lo; v <= top; v += step) if (v === value) return true;
      }
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => parseInt(n, 10));
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
      continue;
    }
    if (parseInt(part, 10) === value) return true;
  }
  return false;
}

function cronMatches(expr: string, d: Date, tz: string): boolean {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const p = zonedParts(d, tz);
  return (
    fieldMatch(f[0] ?? "*", p.minute) &&
    fieldMatch(f[1] ?? "*", p.hour) &&
    fieldMatch(f[2] ?? "*", p.dom) &&
    fieldMatch(f[3] ?? "*", p.month) &&
    fieldMatch(f[4] ?? "*", p.dow)
  );
}

function mostRecentDue(expr: string, now: Date, tz: string, lookbackMin = 1500): number | null {
  const base = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let i = 0; i <= lookbackMin; i++) {
    const t = base - i * 60_000;
    if (cronMatches(expr, new Date(t), tz)) return t;
  }
  return null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startModelDiscoveryScheduler(onLog: (line: string) => void = () => {}): void {
  if (timer) return;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const schedule = refreshCron();
      const tz = schedulerTimeZone();
      const now = new Date();
      const cache = readCacheFile();
      if (!cache) {
        await refreshModelCatalog({ reason: "initial", onLog }).catch((e) => onLog(`[models] initial refresh failed: ${e}`));
        return;
      }
      const due = mostRecentDue(schedule, now, tz);
      if (due === null) return;
      if (cache.lastScheduledRunAt && cache.lastScheduledRunAt >= due) return;
      if (cache.refreshedAt >= due) return;
      await refreshModelCatalog({ reason: "scheduled", scheduledRunAt: due, onLog }).catch((e) => onLog(`[models] scheduled refresh failed: ${e}`));
    } finally {
      ticking = false;
    }
  };
  timer = setInterval(() => void tick(), 60_000);
  setTimeout(() => void tick(), 5_000);
  onLog(`[models] scheduler started (cron="${refreshCron()}", tz=${schedulerTimeZone()})`);
}
