import { chmodSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code stores OAuth credentials in ~/.claude/.credentials.json on
// Linux, but in the login Keychain (service "Claude Code-credentials") on
// macOS — same JSON blob either way. Every reader goes through here so the
// darwin fallback exists exactly once.
// ponytail: 60s cache so dashboard polls don't shell out to `security` each time.

type ClaudeOauth = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};
type ClaudeCreds = { claudeAiOauth?: ClaudeOauth };

let cached: { token: string | null; at: number } | null = null;
const TTL_MS = 60_000;

// Claude Code's own OAuth client. Access tokens live ~8h; the CLI silently
// refreshes them whenever it runs. LFG reads the same file without running the
// CLI, so for an account that hasn't started a session lately the stored token
// is simply expired — every direct call (the usage endpoint) then 401s.
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
// Refresh a little early: a token that expires mid-flight is a wasted 401.
const EXPIRY_SKEW_MS = 60_000;

export const CLAUDE_PLATFORM_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

function defaultConfigDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude");
}

function readCredsFile(configDir = defaultConfigDir()): ClaudeCreds | null {
  try {
    return JSON.parse(
      readFileSync(
        join(configDir, ".credentials.json"),
        "utf8",
      ),
    ) as ClaudeCreds;
  } catch {
    return null;
  }
}

function readCredsKeychain(): ClaudeCreds | null {
  if (process.platform !== "darwin") return null;
  try {
    const proc = Bun.spawnSync(
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (proc.exitCode !== 0) return null;
    return JSON.parse(proc.stdout.toString().trim()) as ClaudeCreds;
  } catch {
    return null;
  }
}

/**
 * Drop the Keychain cache. Test seam: the 60s TTL is process-wide, so without
 * this a token read by one test stays visible to the next.
 */
export function resetClaudeCredsCacheForTests(): void {
  cached = null;
}

/**
 * Claude subscription OAuth access token, or null when not signed in.
 *
 * `readKeychain` is injectable for tests only. Unlike the credentials file, the
 * Keychain is not scoped to $HOME, so a test that points HOME at an empty temp
 * directory still sees the developer's real login and cannot assert a miss.
 */
export function claudeOauthToken(
  configDir?: string,
  readKeychain: () => ClaudeCreds | null = readCredsKeychain,
): string | null {
  // The Linux credentials file is cheap to read and can appear while LFG is
  // running after a browser login. Read it before the Keychain cache so a
  // completed first-run connection is visible on the very next status poll.
  const fileToken = readCredsFile(configDir)?.claudeAiOauth?.accessToken ?? null;
  if (fileToken) return fileToken;
  // Custom config directories are intentionally file-backed. Falling through
  // to the one machine-wide Keychain entry would make every isolated account
  // resolve to the same login on macOS.
  if (configDir && configDir !== defaultConfigDir()) return null;
  if (process.platform !== "darwin") return null;

  if (cached && Date.now() - cached.at < TTL_MS) return cached.token;
  const creds = readKeychain();
  const token = creds?.claudeAiOauth?.accessToken ?? null;
  cached = { token, at: Date.now() };
  return token;
}

// One refresh per config dir at a time. The usage endpoint is polled from
// several places at once, and a rotated refresh token is single-use: two
// concurrent refreshes would race, and the loser would persist a token the
// server has already invalidated.
const refreshing = new Map<string, Promise<string | null>>();

async function refreshFileToken(configDir: string, creds: ClaudeCreds): Promise<string | null> {
  const oauth = creds.claudeAiOauth;
  if (!oauth?.refreshToken) return null;
  try {
    const r = await fetch(CLAUDE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
    });
    if (!r.ok) return null;
    const payload = (await r.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) return null;
    const next: ClaudeCreds = {
      ...creds,
      claudeAiOauth: {
        ...oauth,
        accessToken: payload.access_token,
        // The server rotates the refresh token. Persist the new one or the
        // next refresh presents a spent credential.
        refreshToken: payload.refresh_token ?? oauth.refreshToken,
        expiresAt:
          typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
            ? Date.now() + payload.expires_in * 1000
            : oauth.expiresAt,
      },
    };
    // Write through a temp file in the same directory: a torn write here costs
    // the account its login, and rename is atomic within one filesystem.
    const target = join(configDir, ".credentials.json");
    const tmp = `${target}.lfg-${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(next, null, 2) + "\n");
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    return payload.access_token;
  } catch {
    return null;
  }
}

/**
 * Claude subscription access token, refreshed first if the stored one has
 * expired. Prefer this over `claudeOauthToken` for anything that calls
 * Anthropic directly; the sync reader stays for "is this account connected?"
 * checks, which only need a credential to exist.
 *
 * Keychain-backed logins (macOS default account) are left to the CLI — LFG
 * doesn't write the Keychain — so those fall back to the stored token.
 */
export async function claudeAccessToken(configDir?: string): Promise<string | null> {
  const dir = configDir ?? defaultConfigDir();
  const creds = readCredsFile(dir);
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) return claudeOauthToken(configDir);
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number" || expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return oauth.accessToken;
  }
  const inflight = refreshing.get(dir);
  if (inflight) return (await inflight) ?? oauth.accessToken;
  const run = refreshFileToken(dir, creds!).finally(() => refreshing.delete(dir));
  refreshing.set(dir, run);
  // Fall back to the expired token rather than nothing: the caller's own error
  // path ("sign-in expired") is a better message than "not signed in".
  return (await run) ?? oauth.accessToken;
}

/**
 * Build the full environment for a Claude subprocess owned by a connected
 * Claude account. The Agent SDK treats `env` as a complete replacement, so
 * preserve every unrelated variable while removing the platform proxy/auth
 * variables that otherwise override ~/.claude/.credentials.json.
 */
export function claudeAccountEnv(
  source: NodeJS.ProcessEnv = process.env,
  accountConnected = claudeOauthToken() !== null,
  configDir?: string,
): Record<string, string> | undefined {
  if (!accountConnected) return undefined;
  const blocked = new Set<string>(CLAUDE_PLATFORM_ENV_KEYS);
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !blocked.has(entry[0]),
    ),
  );
  if (configDir && configDir !== defaultConfigDir()) {
    env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}
