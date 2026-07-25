// Cross-provider usage / rate-limit reporting for the Settings → Usage page.
//
// Each agent kind exposes its limits differently:
//   - Claude  : live OAuth usage endpoint (5-hour + 7-day utilization).
//   - Codex   : no public usage API, but the CLI persists the server's
//               rate-limit snapshot into each session rollout. We read the
//               newest rollout and surface its last `rate_limits` block, plus
//               the ChatGPT plan decoded from the local auth token.
//   - Grok    : cli-chat-proxy billing endpoints (monthly credits + weekly
//               creditUsagePercent). Auth is the OIDC access token in
//               ~/.grok/auth.json (same token the CLI uses for /usage).
//   - OpenCode: estimated from local opencode.db spend vs Go plan caps.
//
// Results are cached for 60s so reopening Settings doesn't hammer Anthropic or
// re-walk the Codex sessions tree.

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { claudeOauthToken } from "./claude-creds.ts";

export type UsageWindow = {
  label: string;
  /** 0–100 percent of the window consumed, or null if unknown. */
  pct: number | null;
  /** Epoch ms when the window resets, or null. */
  resetsAt: number | null;
};

export type ProviderUsage = {
  kind: string;
  label: string;
  /** True when we have real usage numbers to show. */
  available: boolean;
  /** Subscription plan name when known (e.g. Codex "prolite"). */
  plan?: string | null;
  /** Human-readable explanation when `available` is false. */
  note?: string;
  windows?: UsageWindow[];
};

const HOME = homedir();

function isoToMs(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
}

function secToMs(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1000) : null;
}

function decodeJwt(token: unknown): Record<string, unknown> | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Claude ----

async function claudeUsage(): Promise<ProviderUsage> {
  const base = { kind: "claude", label: "Claude", plan: null as string | null };
  try {
    const token = claudeOauthToken();
    if (!token) return { ...base, available: false, note: "Not signed in on this box" };
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!r.ok) return { ...base, available: false, note: `Usage endpoint returned ${r.status}` };
    const u = (await r.json()) as {
      five_hour?: { utilization?: number; resets_at?: string | null };
      seven_day?: { utilization?: number; resets_at?: string | null };
    };
    return {
      ...base,
      available: true,
      windows: [
        {
          label: "5 hr",
          pct: u.five_hour?.utilization ?? null,
          resetsAt: isoToMs(u.five_hour?.resets_at),
        },
        {
          label: "7 day",
          pct: u.seven_day?.utilization ?? null,
          resetsAt: isoToMs(u.seven_day?.resets_at),
        },
      ],
    };
  } catch (e) {
    return { ...base, available: false, note: e instanceof Error ? e.message : String(e) };
  }
}

// ----------------------------------------------------------------- Codex ----

// Recursively find the most-recently-modified file with the given extension.
async function newestFile(dir: string, ext: string): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null;
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(ext)) {
        try {
          const st = await stat(p);
          if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
        } catch {
          /* ignore unreadable */
        }
      }
    }
  }
  await walk(dir);
  return best ? (best as { path: string }).path : null;
}

type RateWindow = { used_percent?: number; window_minutes?: number; resets_at?: number };

// Deep-search a parsed JSONL record for the first `rate_limits` object.
function findRateLimits(
  obj: unknown,
): { primary?: RateWindow; secondary?: RateWindow } | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  if (rec.rate_limits && typeof rec.rate_limits === "object")
    return rec.rate_limits as { primary?: RateWindow; secondary?: RateWindow };
  for (const v of Object.values(rec)) {
    if (v && typeof v === "object") {
      const hit = findRateLimits(v);
      if (hit) return hit;
    }
  }
  return null;
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440} day`;
  if (minutes % 60 === 0) return `${minutes / 60} hr`;
  return `${minutes} min`;
}

async function codexUsage(): Promise<ProviderUsage> {
  let plan: string | null = null;
  try {
    const auth = await Bun.file(join(HOME, ".codex", "auth.json")).json();
    const claims = decodeJwt(auth?.tokens?.id_token);
    const oai = claims?.["https://api.openai.com/auth"] as
      | { chatgpt_plan_type?: string }
      | undefined;
    plan = oai?.chatgpt_plan_type ?? null;
  } catch {
    /* not signed in / unreadable */
  }
  const base = { kind: "codex", label: "Codex", plan };
  try {
    const newest = await newestFile(join(HOME, ".codex", "sessions"), ".jsonl");
    if (!newest)
      return { ...base, available: false, note: "No recent Codex sessions on this box" };
    const text = await Bun.file(newest).text();
    const lines = text.split("\n");
    let rl: { primary?: RateWindow; secondary?: RateWindow } | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const hit = findRateLimits(JSON.parse(lines[i]));
        if (hit) {
          rl = hit;
          break;
        }
      } catch {
        /* skip malformed line */
      }
    }
    if (!rl)
      return {
        ...base,
        available: false,
        note: "No rate-limit data recorded yet — run a Codex turn",
      };
    const windows: UsageWindow[] = [];
    if (rl.primary)
      windows.push({
        label: windowLabel(rl.primary.window_minutes, "Session"),
        pct: rl.primary.used_percent ?? null,
        resetsAt: secToMs(rl.primary.resets_at),
      });
    if (rl.secondary)
      windows.push({
        label: windowLabel(rl.secondary.window_minutes, "Weekly"),
        pct: rl.secondary.used_percent ?? null,
        resetsAt: secToMs(rl.secondary.resets_at),
      });
    return { ...base, available: true, windows };
  } catch (e) {
    return { ...base, available: false, note: e instanceof Error ? e.message : String(e) };
  }
}

// ------------------------------------------------------------------ Grok ----

// Grok CLI /usage hits cli-chat-proxy (not api.x.ai):
//   GET /v1/billing                 → monthly credits used/limit + period end
//   GET /v1/billing?format=credits  → weekly creditUsagePercent + period end
// Nested money fields use `{ val: number }` wrappers. The access token lives
// in ~/.grok/auth.json under the OIDC entry (key + refresh_token).
const GROK_BILLING_BASE = "https://cli-chat-proxy.grok.com/v1";
const GROK_OIDC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";

type GrokAuthEntry = {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  email?: string;
  auth_mode?: string;
  oidc_client_id?: string;
};

function nestedVal(obj: unknown): number | null {
  if (typeof obj === "number" && Number.isFinite(obj)) return obj;
  if (obj && typeof obj === "object" && typeof (obj as { val?: unknown }).val === "number") {
    const n = (obj as { val: number }).val;
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function grokRefreshAccessToken(
  entry: GrokAuthEntry,
  authPath: string,
  authRoot: Record<string, GrokAuthEntry>,
  entryKey: string,
): Promise<string | null> {
  if (!entry.refresh_token) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: entry.oidc_client_id || GROK_OIDC_CLIENT_ID,
      refresh_token: entry.refresh_token,
    });
    const r = await fetch(GROK_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!r.ok) return null;
    const payload = (await r.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) return null;
    entry.key = payload.access_token;
    if (payload.refresh_token) entry.refresh_token = payload.refresh_token;
    if (typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)) {
      entry.expires_at = new Date(Date.now() + payload.expires_in * 1000).toISOString();
    }
    authRoot[entryKey] = entry;
    try {
      await Bun.write(authPath, JSON.stringify(authRoot, null, 2) + "\n");
    } catch {
      /* best-effort persist; still use refreshed token this request */
    }
    return payload.access_token;
  } catch {
    return null;
  }
}

async function grokFetchBilling(token: string): Promise<{
  monthly: Response;
  weekly: Response;
}> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "x-xai-token-auth": "xai-grok-cli",
  };
  const [monthly, weekly] = await Promise.all([
    fetch(`${GROK_BILLING_BASE}/billing`, { headers }),
    fetch(`${GROK_BILLING_BASE}/billing?format=credits`, { headers }),
  ]);
  return { monthly, weekly };
}

async function grokUsage(): Promise<ProviderUsage> {
  const base = { kind: "grok", label: "Grok", plan: null as string | null };
  try {
    const authPath = join(HOME, ".grok", "auth.json");
    const authRoot = (await Bun.file(authPath).json()) as Record<string, GrokAuthEntry>;
    const entryKey = Object.keys(authRoot).find((k) => {
      const e = authRoot[k];
      return e && typeof e.key === "string" && e.key.length > 0;
    });
    if (!entryKey) return { ...base, available: false, note: "Not signed in on this box" };
    const entry = authRoot[entryKey];
    let token = entry.key!;

    // Refresh a bit early if we know expiry; also retry once on 401.
    const expMs = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
    if (Number.isFinite(expMs) && expMs - Date.now() < 60_000) {
      const refreshed = await grokRefreshAccessToken(entry, authPath, authRoot, entryKey);
      if (refreshed) token = refreshed;
    }

    let { monthly, weekly } = await grokFetchBilling(token);
    if (monthly.status === 401 || weekly.status === 401) {
      const refreshed = await grokRefreshAccessToken(entry, authPath, authRoot, entryKey);
      if (!refreshed)
        return { ...base, available: false, note: "Grok auth expired — run `grok login`" };
      token = refreshed;
      ({ monthly, weekly } = await grokFetchBilling(token));
    }

    if (!monthly.ok)
      return { ...base, available: false, note: `Billing endpoint returned ${monthly.status}` };

    const monthlyJson = (await monthly.json()) as {
      config?: {
        monthlyLimit?: unknown;
        used?: unknown;
        billingPeriodEnd?: string;
      };
    };
    const limit = nestedVal(monthlyJson.config?.monthlyLimit);
    const used = nestedVal(monthlyJson.config?.used);
    const monthlyEnd = monthlyJson.config?.billingPeriodEnd;

    const windows: UsageWindow[] = [];
    if (limit != null && used != null && limit > 0) {
      windows.push({
        label: "Monthly",
        pct: Math.min(100, (used / limit) * 100),
        resetsAt: isoToMs(monthlyEnd),
      });
    }

    if (weekly.ok) {
      try {
        const weeklyJson = (await weekly.json()) as {
          config?: {
            currentPeriod?: { type?: string };
            creditUsagePercent?: number;
            billingPeriodEnd?: string;
          };
        };
        const cfg = weeklyJson.config;
        const pct = cfg?.creditUsagePercent;
        if (typeof pct === "number" && Number.isFinite(pct)) {
          const periodType = cfg?.currentPeriod?.type ?? "";
          const label =
            periodType === "USAGE_PERIOD_TYPE_WEEKLY"
              ? "Weekly"
              : periodType === "USAGE_PERIOD_TYPE_MONTHLY"
                ? "Monthly credits"
                : "Credits";
          windows.unshift({
            label,
            pct: Math.min(100, pct),
            resetsAt: isoToMs(cfg?.billingPeriodEnd),
          });
        }
      } catch {
        /* weekly is optional enrichment */
      }
    }

    if (!windows.length)
      return { ...base, available: false, note: "Billing response had no usage windows" };

    return { ...base, available: true, windows };
  } catch (e) {
    return { ...base, available: false, note: e instanceof Error ? e.message : String(e) };
  }
}

// -------------------------------------------------------------- OpenCode ----

function staticProvider(kind: string, label: string, note: string): ProviderUsage {
  return { kind, label, available: false, plan: null, note };
}

function compactCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function opencodeStatsNote(): string | null {
  try {
    const db = new Database(join(HOME, ".local", "share", "opencode", "opencode.db"), {
      readonly: true,
    });
    try {
      const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const row = db
        .query(
          `select
             count(*) as sessions,
             coalesce(sum(cost), 0) as cost,
             coalesce(sum(tokens_input), 0) as input,
             coalesce(sum(tokens_output), 0) as output,
             coalesce(sum(tokens_cache_read), 0) as cache_read
           from session
           where time_updated >= ?`,
        )
        .get(since) as
        | {
            sessions?: number;
            cost?: number;
            input?: number;
            output?: number;
            cache_read?: number;
          }
        | null;
      if (!row?.sessions) return "Signed in; no local OpenCode usage in the last 7 days";
      const tokens = (row.input ?? 0) + (row.output ?? 0) + (row.cache_read ?? 0);
      return `Signed in; 7d local stats: ${row.sessions} sessions, ${compactCount(tokens)} tokens, $${(row.cost ?? 0).toFixed(2)}`;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// OpenCode Go's published spend caps, per rolling window. Unlike Claude/Codex,
// Go exposes no live "how much have I used" figure we can reach with the local
// gateway key (it lives only in their web console, behind an account session).
// But the CLI still records each message's underlying-model cost in opencode.db
// — the very dollar figure these caps are measured against — even though the
// gateway bills $0. We sum that per window and divide by the cap to reconstruct
// the usage % the console shows. It's an estimate: local to this box, so it
// under-counts if the same Go account is used on another machine.
const GO_CAPS = "Go plan caps: $12 / 5h · $30 / week · $60 / month (live usage not exposed by OpenCode)";
const GO_WINDOWS: { label: string; ms: number; cap: number }[] = [
  { label: "5-hour · $12", ms: 5 * 60 * 60 * 1000, cap: 12 },
  { label: "weekly · $30", ms: 7 * 24 * 60 * 60 * 1000, cap: 30 },
  { label: "monthly · $60", ms: 30 * 24 * 60 * 60 * 1000, cap: 60 },
];

function opencodeGoWindows(): UsageWindow[] | null {
  try {
    const db = new Database(join(HOME, ".local", "share", "opencode", "opencode.db"), {
      readonly: true,
    });
    try {
      const now = Date.now();
      const oldest = now - Math.max(...GO_WINDOWS.map((w) => w.ms));
      const rows = db
        .query("select data, time_created from message where time_created >= ?")
        .all(oldest) as { data: string; time_created: number }[];
      const spends: { t: number; cost: number }[] = [];
      for (const r of rows) {
        let d: { role?: string; providerID?: string; cost?: unknown } | null = null;
        try {
          d = JSON.parse(r.data);
        } catch {
          continue;
        }
        if (d?.role !== "assistant" || d?.providerID !== "opencode-go") continue;
        const cost = typeof d.cost === "number" ? d.cost : 0;
        if (cost > 0) spends.push({ t: r.time_created, cost });
      }
      if (!spends.length) return null;
      return GO_WINDOWS.map((w) => {
        const start = now - w.ms;
        const spent = spends.reduce((s, c) => (c.t >= start ? s + c.cost : s), 0);
        return { label: w.label, pct: Math.min(100, (spent / w.cap) * 100), resetsAt: null };
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function opencodeUsage(): Promise<ProviderUsage> {
  const base = { kind: "opencode", label: "OpenCode", plan: null as string | null };
  try {
    const auth = await Bun.file(join(HOME, ".local", "share", "opencode", "auth.json")).json();
    const hasGo = typeof auth?.["opencode-go"]?.key === "string" && auth["opencode-go"].key.length > 0;
    const hasAny = Object.values(auth ?? {}).some(
      (v) => v && typeof v === "object" && typeof (v as { key?: unknown }).key === "string",
    );
    if (!hasAny) return { ...base, available: false, note: "Not signed in on this box" };
    if (hasGo) {
      const windows = opencodeGoWindows();
      const stats = opencodeStatsNote();
      return {
        ...base,
        available: true,
        plan: "go",
        windows: windows ?? undefined,
        note: windows
          ? "Estimated from this device's OpenCode Go usage vs. plan caps ($12/5h · $30/wk · $60/mo)"
          : `${GO_CAPS}.${stats ? ` ${stats}` : ""}`,
      };
    }
    return { ...base, available: true, plan: null, note: opencodeStatsNote() ?? "Signed in" };
  } catch {
    return { ...base, available: false, note: "Not signed in on this box" };
  }
}

// ----------------------------------------------------------- aggregation ----

let cache: { at: number; data: ProviderUsage[] } | null = null;

export async function getAllUsage(): Promise<ProviderUsage[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.data;
  const data = await Promise.all([
    claudeUsage(),
    codexUsage(),
    grokUsage(),
    Promise.resolve(
      staticProvider("hermes", "Hermes", "Usage is stored in Hermes' own state database"),
    ),
    opencodeUsage(),
  ]);
  cache = { at: Date.now(), data };
  return data;
}
