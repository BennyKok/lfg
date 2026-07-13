import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SourceUpdateStatus = {
  channel: "source";
  state: "up-to-date" | "available" | "blocked";
  currentSha?: string;
  latestSha?: string;
  commitsBehind?: number;
  message: string;
  restartSupported: boolean;
};

type CommandResult = { ok: boolean; stdout: string; stderr: string };

async function run(cmd: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function blocked(message: string): SourceUpdateStatus {
  return {
    channel: "source",
    state: "blocked",
    message,
    restartSupported: restartCommand() !== null,
  };
}

export function restartCommand(platform = process.platform): string[] | null {
  if (platform === "linux") {
    if (!existsSync(join(homedir(), ".config", "systemd", "user", "lfg.service"))) return null;
    for (const systemctl of ["/usr/bin/systemctl", "/bin/systemctl"]) {
      try {
        accessSync(systemctl, constants.X_OK);
        return [systemctl, "--user", "restart", "lfg.service"];
      } catch {}
    }
    return null;
  }
  if (platform === "darwin") {
    const launchctl = "/bin/launchctl";
    if (!existsSync(join(homedir(), "Library", "LaunchAgents", "dev.omg.lfg.plist"))) return null;
    try {
      accessSync(launchctl, constants.X_OK);
      return [launchctl, "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/dev.omg.lfg`];
    } catch {
      return null;
    }
  }
  return null;
}

export async function sourceUpdateStatus(root: string, fetch = true): Promise<SourceUpdateStatus> {
  const inside = await run(["git", "rev-parse", "--is-inside-work-tree"], root);
  if (!inside.ok || inside.stdout !== "true") return blocked("This install is not a Git checkout.");

  const branch = await run(["git", "branch", "--show-current"], root);
  if (!branch.ok || !branch.stdout) return blocked("The LFG checkout has a detached HEAD.");
  if (branch.stdout !== "main") {
    return blocked(`LFG is on branch ${branch.stdout}; switch to main before updating.`);
  }

  const dirty = await run(["git", "status", "--porcelain"], root);
  if (!dirty.ok) return blocked(dirty.stderr || "Could not inspect the LFG checkout.");
  if (dirty.stdout) return blocked("The LFG checkout has local changes. Commit or stash them first.");

  if (fetch) {
    const fetched = await run(["git", "fetch", "--quiet", "origin", "main"], root);
    if (!fetched.ok) return blocked(fetched.stderr || "Could not fetch origin/main.");
  }

  const head = await run(["git", "rev-parse", "HEAD"], root);
  const latest = await run(["git", "rev-parse", "origin/main"], root);
  if (!head.ok || !latest.ok) return blocked(latest.stderr || head.stderr || "origin/main is unavailable.");

  const base = {
    channel: "source" as const,
    currentSha: head.stdout,
    latestSha: latest.stdout,
    restartSupported: restartCommand() !== null,
  };
  if (head.stdout === latest.stdout) {
    return { ...base, state: "up-to-date", message: `LFG is up to date (${short(head.stdout)}).` };
  }

  const behind = await run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], root);
  if (!behind.ok) {
    const ahead = await run(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"], root);
    return blocked(
      ahead.ok
        ? "Local main has commits that are not on origin/main."
        : "Local main and origin/main have diverged.",
    );
  }

  const count = await run(["git", "rev-list", "--count", "HEAD..origin/main"], root);
  const commitsBehind = Number.parseInt(count.stdout, 10) || 0;
  return {
    ...base,
    state: "available",
    commitsBehind,
    message: `${commitsBehind} update${commitsBehind === 1 ? "" : "s"} available (${short(latest.stdout)}).`,
  };
}

export async function applySourceUpdate(
  root: string,
): Promise<{ status: SourceUpdateStatus; updated: boolean }> {
  const status = await sourceUpdateStatus(root, true);
  if (status.state === "blocked") return { status, updated: false };
  if (!status.restartSupported) {
    throw new Error("Automatic restart is unavailable on this install.");
  }

  if (status.state === "available") {
    const merge = await run(["git", "merge", "--ff-only", "origin/main"], root);
    if (!merge.ok) throw new Error(merge.stderr || "Could not fast-forward to origin/main.");
  }

  const bun = process.execPath;
  const install = await run([bun, "install", "--frozen-lockfile"], root);
  if (!install.ok) throw new Error(install.stderr || "Dependency installation failed.");
  const webRoot = join(root, "web");
  const webInstall = await run([bun, "install", "--frozen-lockfile"], webRoot);
  if (!webInstall.ok) throw new Error(webInstall.stderr || "Web dependency installation failed.");
  const build = await run([bun, "run", "build"], webRoot);
  if (!build.ok) throw new Error(build.stderr || "Web build failed.");

  return { status: await sourceUpdateStatus(root, false), updated: true };
}

export function scheduleRestart(delayMs = 1_000): void {
  const cmd = restartCommand();
  if (!cmd) throw new Error("Automatic restart is unavailable on this install.");
  setTimeout(() => {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    proc.unref();
  }, delayMs);
}
