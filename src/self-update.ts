import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type SourceUpdateStatus = {
  channel: "source";
  state: "up-to-date" | "available" | "blocked";
  currentSha?: string;
  latestSha?: string;
  commitsBehind?: number;
  message: string;
  restartSupported: boolean;
};

export type ReleaseUpdateStatus = {
  channel: "release";
  state: "up-to-date" | "available" | "blocked";
  currentVersion?: string;
  latestVersion?: string;
  latestTag?: string;
  message: string;
  restartSupported: boolean;
};

export type LfgUpdateStatus = SourceUpdateStatus | ReleaseUpdateStatus;

export type ReleaseInstall = {
  repoSlug?: string;
  releaseAsset?: string;
};

type CommandResult = { ok: boolean; stdout: string; stderr: string };

const OMG_SERVE_SCRIPT = ".omg/agent-serve.sh";
const OMG_SERVE_PID = ".omg/agent-serve.pid";

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

function cleanVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

function installedVersion(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

type GithubRelease = { tag_name?: unknown };
const releaseTagCache = new Map<string, { tag: string; expiresAt: number }>();

async function latestReleaseTag(repoSlug: string, force = false): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repoSlug)) {
    throw new Error("The configured GitHub repository is invalid.");
  }
  if (!force) {
    const cached = releaseTagCache.get(repoSlug);
    if (cached && cached.expiresAt > Date.now()) return cached.tag;
  }
  const response = await fetch(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "lfg-self-update" },
  });
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
  const parsed = (await response.json()) as GithubRelease;
  if (typeof parsed.tag_name !== "string" || !parsed.tag_name.trim()) {
    throw new Error("The latest GitHub release has no tag.");
  }
  const tag = parsed.tag_name.trim();
  releaseTagCache.set(repoSlug, { tag, expiresAt: Date.now() + 5 * 60_000 });
  return tag;
}

export async function releaseUpdateStatus(
  root: string,
  install: ReleaseInstall,
  force = false,
): Promise<ReleaseUpdateStatus> {
  const currentVersion = installedVersion(root);
  const repoSlug = install.repoSlug;
  if (!currentVersion) {
    return {
      channel: "release",
      state: "blocked",
      message: "Could not determine the installed LFG version.",
      restartSupported: restartCommand() !== null,
    };
  }
  if (!repoSlug) {
    return {
      channel: "release",
      state: "blocked",
      currentVersion,
      message: "This release install has no GitHub repository configured.",
      restartSupported: restartCommand() !== null,
    };
  }
  try {
    const latestTag = await latestReleaseTag(repoSlug, force);
    const latestVersion = cleanVersion(latestTag);
    const base = {
      channel: "release" as const,
      currentVersion,
      latestVersion,
      latestTag,
      restartSupported: restartCommand() !== null,
    };
    if (cleanVersion(currentVersion) === latestVersion) {
      return { ...base, state: "up-to-date", message: `LFG ${currentVersion} is up to date.` };
    }
    return {
      ...base,
      state: "available",
      message: `LFG ${latestVersion} is available (installed ${currentVersion}).`,
    };
  } catch (e) {
    return {
      channel: "release",
      state: "blocked",
      currentVersion,
      message: e instanceof Error ? e.message : String(e),
      restartSupported: restartCommand() !== null,
    };
  }
}

function blocked(message: string): SourceUpdateStatus {
  return {
    channel: "source",
    state: "blocked",
    message,
    restartSupported: restartCommand() !== null,
  };
}

function omgSupervisorRestartCommand(
  home = homedir(),
  procRoot = "/proc",
  currentPid = process.pid,
): string[] | null {
  if (process.platform !== "linux") return null;
  const script = join(home, OMG_SERVE_SCRIPT);
  const pidFile = join(home, OMG_SERVE_PID);
  if (!existsSync(script) || !existsSync(pidFile)) return null;
  try {
    const supervisorPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 1) return null;
    const cmdline = readFileSync(join(procRoot, String(supervisorPid), "cmdline"), "utf8")
      .replaceAll("\0", " ");
    if (!cmdline.includes(OMG_SERVE_SCRIPT)) return null;
    for (const kill of ["/usr/bin/kill", "/bin/kill"]) {
      try {
        accessSync(kill, constants.X_OK);
        // The OMG-owned loop observes this process exit and starts the updated
        // foreground command again after its normal two-second backoff.
        return [kill, "-TERM", String(currentPid)];
      } catch {}
    }
  } catch {}
  return null;
}

export function restartCommand(
  platform = process.platform,
  home = homedir(),
  procRoot = "/proc",
): string[] | null {
  if (platform === "linux") {
    if (existsSync(join(home, ".config", "systemd", "user", "lfg.service"))) {
      for (const systemctl of ["/usr/bin/systemctl", "/bin/systemctl"]) {
        try {
          accessSync(systemctl, constants.X_OK);
          return [systemctl, "--user", "restart", "lfg.service"];
        } catch {}
      }
    }
    return omgSupervisorRestartCommand(home, procRoot);
  }
  if (platform === "darwin") {
    const launchctl = "/bin/launchctl";
    if (!existsSync(join(home, "Library", "LaunchAgents", "dev.omg.lfg.plist"))) return null;
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

async function download(url: string, destination: string): Promise<Response> {
  const response = await fetch(url, { headers: { "User-Agent": "lfg-self-update" } });
  if (!response.ok) throw new Error(`Release download failed (${response.status}).`);
  await Bun.write(destination, await response.arrayBuffer());
  return response;
}

export async function applyReleaseUpdate(
  root: string,
  install: ReleaseInstall,
): Promise<{ status: ReleaseUpdateStatus; updated: boolean }> {
  const status = await releaseUpdateStatus(root, install);
  if (status.state === "blocked") return { status, updated: false };
  if (!status.restartSupported) throw new Error("Automatic restart is unavailable on this install.");

  const repoSlug = install.repoSlug!;
  const tag = status.latestTag!;
  const asset = install.releaseAsset || "lfg-bundle.tar.gz";
  if (!/^[a-zA-Z0-9._-]+$/.test(asset)) throw new Error("The configured release asset is invalid.");
  const url = `https://github.com/${repoSlug}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
  const temp = mkdtempSync(join(tmpdir(), "lfg-update-"));
  const archive = join(temp, asset);

  try {
    await download(url, archive);

    // Releases normally publish a sibling checksum. Keep compatibility with
    // older bundles that do not have one, matching setup.sh's best-effort rule.
    const checksumResponse = await fetch(`${url}.sha256`, {
      headers: { "User-Agent": "lfg-self-update" },
    });
    if (checksumResponse.ok) {
      const checksumText = await checksumResponse.text();
      const expected = checksumText.match(/\b[a-fA-F0-9]{64}\b/)?.[0]?.toLowerCase();
      if (!expected) throw new Error("The release checksum file is invalid.");
      const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
      if (actual !== expected) throw new Error("Release checksum mismatch; update refused.");
    }

    const listing = await run(["tar", "-tzf", archive], root);
    if (!listing.ok) throw new Error(listing.stderr || "The release bundle is not a valid archive.");
    const entries = listing.stdout.split("\n").filter(Boolean);
    if (
      !entries.length
      || entries.some((entry) => {
        const parts = entry.split("/");
        return (parts[0] !== "lfg" || parts.includes(".."));
      })
    ) {
      throw new Error("The release bundle contains unsafe paths.");
    }

    const extract = await run(["tar", "-xzf", archive, "-C", root, "--strip-components=1"], root);
    if (!extract.ok) throw new Error(extract.stderr || "Could not extract the release bundle.");

    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const installResult = await run([process.execPath, "install", "--production"], root);
    if (!installResult.ok) {
      throw new Error(installResult.stderr || installResult.stdout || "Dependency installation failed.");
    }

    const currentVersion = installedVersion(root) || status.latestVersion;
    return {
      updated: true,
      status: {
        channel: "release",
        state: "up-to-date",
        currentVersion,
        latestVersion: status.latestVersion,
        latestTag: status.latestTag,
        restartSupported: true,
        message: `LFG ${currentVersion} is installed.`,
      },
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function scheduleRestart(delayMs = 1_000): void {
  const cmd = restartCommand();
  if (!cmd) throw new Error("Automatic restart is unavailable on this install.");
  setTimeout(() => {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    proc.unref();
  }, delayMs);
}
