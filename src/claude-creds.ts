import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code stores OAuth credentials in ~/.claude/.credentials.json on
// Linux, but in the login Keychain (service "Claude Code-credentials") on
// macOS — same JSON blob either way. Every reader goes through here so the
// darwin fallback exists exactly once.
// ponytail: 60s cache so dashboard polls don't shell out to `security` each time.

type ClaudeCreds = { claudeAiOauth?: { accessToken?: string } };

let cached: { token: string | null; at: number } | null = null;
const TTL_MS = 60_000;

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
