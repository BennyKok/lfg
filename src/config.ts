import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  root: ROOT,
  data: join(ROOT, "data"),
  sessionTitles: join(ROOT, "data", "session-titles.json"),
  installInfo: join(ROOT, "data", "install.json"),
};

export function appVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

export type InstallChannel = "source" | "release" | "container" | "unknown";

export type InstallInfo = {
  channel: InstallChannel;
  repoSlug?: string;
  release?: string;
  releaseAsset?: string;
  installedAt?: string;
  source?: "env" | "file" | "git" | "fallback";
  updateCommand: string;
};

function updateCommand(channel: InstallChannel): string {
  if (channel === "source") return "git pull --ff-only && bun install && (cd web && bun install && bun run build)";
  if (channel === "container") return "redeploy the container after publishing a new lfg-bundle.tar.gz";
  if (channel === "release") return "lfg setup";
  return "check the install method, then update from the latest GitHub release or source checkout";
}

function cleanChannel(raw: string | undefined): InstallChannel | null {
  if (raw === "source" || raw === "release" || raw === "container") return raw;
  return null;
}

export function installInfo(): InstallInfo {
  const envChannel = cleanChannel(process.env.LFG_INSTALL_CHANNEL);
  if (envChannel) {
    return {
      channel: envChannel,
      repoSlug: process.env.LFG_REPO_SLUG,
      release: process.env.LFG_RELEASE,
      releaseAsset: process.env.LFG_RELEASE_ASSET,
      source: "env",
      updateCommand: updateCommand(envChannel),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(PATHS.installInfo, "utf8")) as Partial<InstallInfo>;
    const channel = cleanChannel(parsed.channel);
    if (channel) {
      return {
        ...parsed,
        channel,
        source: "file",
        updateCommand: updateCommand(channel),
      };
    }
  } catch {}

  if (existsSync(join(ROOT, ".git"))) {
    return {
      channel: "source",
      source: "git",
      updateCommand: updateCommand("source"),
    };
  }

  return {
    channel: "unknown",
    source: "fallback",
    updateCommand: updateCommand("unknown"),
  };
}
