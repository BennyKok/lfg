import { existsSync } from "node:fs";
import { homedir } from "node:os";

export type ToolConnection = {
  key: "github";
  label: string;
  detail: string;
  installed: boolean;
  connected: boolean;
};

/** One owner for locating the GitHub CLI. The embedded onboarding and auth
 * engine both consume this instead of drifting into different PATH rules. */
export function githubCliPath(): string | null {
  const configured = process.env.LFG_GH_PATH?.trim();
  if (configured && existsSync(configured)) return configured;
  const onPath = Bun.which("gh");
  if (onPath) return onPath;
  const candidates = [
    `${homedir()}/.local/bin/gh`,
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function githubConnection(): ToolConnection {
  const binary = githubCliPath();
  const connected = binary
    ? Bun.spawnSync([binary, "auth", "status", "--hostname", "github.com"], {
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    : false;
  return {
    key: "github",
    label: "GitHub",
    detail: "Private repos, pushes, and pull requests",
    installed: Boolean(binary),
    connected,
  };
}

export function listToolConnections(): ToolConnection[] {
  return [githubConnection()];
}
