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

function readCredsFile(): ClaudeCreds | null {
  try {
    return JSON.parse(
      readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"),
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

/** Claude subscription OAuth access token, or null when not signed in. */
export function claudeOauthToken(): string | null {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.token;
  const creds = readCredsFile() ?? readCredsKeychain();
  const token = creds?.claudeAiOauth?.accessToken ?? null;
  cached = { token, at: Date.now() };
  return token;
}
