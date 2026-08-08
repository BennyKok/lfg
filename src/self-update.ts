import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { installedLaunchAgent, installedSystemdUnit } from "./service-unit.ts";

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

export type ReleaseInstall = {
  repoSlug?: string;
  releaseAsset?: string;
};

type CommandResult = { ok: boolean; stdout: string; stderr: string };

/**
 * OMG sandboxes have no user systemd, so they supervise `lfg serve` with a
 * plain `while true; do <serve>; sleep 2; done` shell loop. Exiting is
 * therefore how LFG restarts itself there — but only if a supervisor really is
 * watching, so each layout pairs its marker files with a token that must appear
 * in the supervisor's /proc cmdline. Without that check a recycled PID could
 * make LFG exit into nothing.
 *
 * Two layouts exist because OMG changed the convention. Both are still in the
 * field: guests baked from an older template run the legacy one, and a guest
 * only moves to the current one when its template is re-baked.
 */
const OMG_SUPERVISORS = [
  {
    // Current: the template writes ~/.omg/template/bootstrap.sh, which nohups
    // the restart loop with a sentinel argv entry so it can identify its own
    // supervisor across a cold boot.
    script: ".omg/template/bootstrap.sh",
    pidFile: ".omg/template/start.pid",
    marker: "omg-template-supervisor",
  },
  {
    // Legacy: the agent-template catalog's ~/.omg/agent-serve.sh loop, which
    // has no sentinel, so the script path in the cmdline is the marker.
    script: ".omg/agent-serve.sh",
    pidFile: ".omg/agent-serve.pid",
    marker: ".omg/agent-serve.sh",
  },
] as const;

async function run(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * True for GNU tar, false for bsdtar (what macOS ships). The two don't share an
 * option vocabulary, and bsdtar treats an unknown long option as a hard usage
 * error rather than ignoring it.
 */
async function tarIsGnu(root: string): Promise<boolean> {
  const probe = await run(["tar", "--version"], root);
  return probe.ok && probe.stdout.includes("GNU tar");
}

// Sandboxes can inject TAR_OPTIONS (notably --keep-old-files), which turns a
// normal release update into hundreds of "Cannot open: File exists" failures.
// Release contents are application files and are meant to replace the prior
// bundle. Avoid restoring archive metadata too: shared/sandbox filesystems may
// allow writes while rejecting chmod/chown/utime, causing a successful content
// update to be reported as a tar failure.
//
// The flags have to be chosen per tar flavour. `--overwrite` and `--touch` are
// GNU-only, and passing them to macOS's bsdtar aborts the extraction with
// "Option --overwrite is not supported" — which broke self-update on a Mac
// outright. bsdtar needs neither: it overwrites by default and ignores
// TAR_OPTIONS (a GNU env var), and it spells --touch as -m.
export async function extractReleaseArchive(
  archive: string,
  root: string,
): Promise<CommandResult> {
  const gnu = await tarIsGnu(root);
  return run(
    [
      "tar",
      "-xzf",
      archive,
      "-C",
      root,
      "--strip-components=1",
      ...(gnu ? ["--overwrite", "--touch"] : ["-m"]),
      "--no-same-owner",
      "--no-same-permissions",
    ],
    root,
    { ...process.env, TAR_OPTIONS: "" },
  );
}

function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract a downloaded release over an install and make its dependencies match.
 *
 * A per-platform bundle ships node_modules already resolved and pruned for this
 * OS/arch, which is the whole reason it exists. Reinstalling on top of it was
 * the slowest possible update: a bundle install never populates Bun's cache, so
 * every dependency the download just delivered got fetched from npm a second
 * time — and the pruned-away musl builds came back with them.
 *
 * The old tree is removed *before* extraction, not after, so two things hold at
 * once: what lands is exactly the bundle's tree rather than a merge that keeps
 * files this release deleted, and node_modules existing afterwards proves the
 * bundle shipped it. That second part is what makes skipping safe — a neutral
 * bundle (which carries no dependencies) still installs, even when the install
 * it replaced had a full node_modules sitting there.
 *
 * Returns whether a target-side install was needed.
 */
export async function installReleaseBundle(
  archive: string,
  root: string,
): Promise<{ dependenciesInstalled: boolean }> {
  const modules = join(root, "node_modules");
  rmSync(modules, { recursive: true, force: true });

  const extract = await extractReleaseArchive(archive, root);
  if (!extract.ok) throw new Error(extract.stderr || "Could not extract the release bundle.");

  if (hasEntries(modules)) return { dependenciesInstalled: false };

  const installResult = await run([process.execPath, "install", "--production"], root);
  if (!installResult.ok) {
    throw new Error(installResult.stderr || installResult.stdout || "Dependency installation failed.");
  }
  return { dependenciesInstalled: true };
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
  // Injectable like restartCommand's own platform argument. Reading
  // process.platform here instead meant the caller's injected value was ignored
  // one level down, so this branch could only ever be exercised on Linux.
  platform: string = process.platform,
): string[] | null {
  if (platform !== "linux") return null;
  for (const layout of OMG_SUPERVISORS) {
    if (!existsSync(join(home, layout.script))) continue;
    if (!existsSync(join(home, layout.pidFile))) continue;
    try {
      const raw = readFileSync(join(home, layout.pidFile), "utf8").trim();
      const supervisorPid = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 1) continue;
      const cmdline = readFileSync(join(procRoot, String(supervisorPid), "cmdline"), "utf8")
        .replaceAll("\0", " ");
      if (!cmdline.includes(layout.marker)) continue;
      for (const kill of ["/usr/bin/kill", "/bin/kill"]) {
        try {
          accessSync(kill, constants.X_OK);
          // The OMG-owned loop observes this process exit and starts the updated
          // foreground command again after its normal two-second backoff.
          return [kill, "-TERM", String(currentPid)];
        } catch {}
      }
    } catch {}
  }
  return null;
}

export function restartCommand(
  platform = process.platform,
  home = homedir(),
  procRoot = "/proc",
): string[] | null {
  if (platform === "linux") {
    // Whichever unit this box was installed under — see src/service-unit.ts.
    // Restarting a hardcoded name would no-op on the other one.
    const unit = installedSystemdUnit(home);
    if (unit) {
      for (const systemctl of ["/usr/bin/systemctl", "/bin/systemctl"]) {
        try {
          accessSync(systemctl, constants.X_OK);
          return [systemctl, "--user", "restart", `${unit}.service`];
        } catch {}
      }
    }
    return omgSupervisorRestartCommand(home, procRoot, process.pid, platform);
  }
  if (platform === "darwin") {
    const launchctl = "/bin/launchctl";
    const label = installedLaunchAgent(home);
    if (!label) return null;
    try {
      accessSync(launchctl, constants.X_OK);
      return [launchctl, "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${label}`];
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
  // Deliberately the pre-rename name as the unknown-install fallback: this
  // branch is reached only when install.json records no asset, which means an
  // install old enough to predate the field. The legacy name is published on
  // every release, old and new; omg-bundle.tar.gz only exists on new ones, so
  // defaulting to it would break updates for exactly the installs that land here.
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

    await installReleaseBundle(archive, root);

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
