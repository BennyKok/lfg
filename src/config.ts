import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  root: ROOT,
  data: join(ROOT, "data"),
  codexSessions: join(process.env.HOME ?? homedir(), ".codex", "sessions"),
  sessionTitles: join(ROOT, "data", "session-titles.json"),
  installInfo: join(ROOT, "data", "install.json"),
};

// LFG_HOST is the server's BIND address, but the in-box clients — `lfg mcp`,
// `lfg subagent`, `lfg connect` — read the same variable to DIAL that server.
// A bind address is not always dialable: every containerized deploy sets
// LFG_HOST to a wildcard (`0.0.0.0`, or `::` where the platform's private
// network is IPv6-only). `http://0.0.0.0:8766` only connects by accident on
// Linux, and `http://:::8766` does not parse as a URL at all. Fold wildcards
// back to loopback and bracket bare IPv6 literals, so the result is always
// safe to interpolate into a URL authority.
export function localServeHost(raw: string | undefined = process.env.LFG_HOST): string {
  const host = raw?.trim();
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  if (host.startsWith("[")) return host;
  // A bare IPv6 literal has at least two colons. One colon means `host:port`,
  // which this variable is not meant to carry — leave it alone rather than
  // bracketing it into something even more wrong.
  return host.split(":").length > 2 ? `[${host}]` : host;
}

// Absolute URL of the local `lfg serve`, for CLI subcommands that talk to it.
export function localServeBaseUrl(): string {
  if (process.env.LFG_BASE) return process.env.LFG_BASE.replace(/\/$/, "");
  const port = process.env.LFG_PORT || process.env.PORT || "8766";
  return `http://${localServeHost()}:${port}`;
}

/**
 * The OMG MCP registration for one specific session, for the Claude Agent SDK's
 * `mcpServers` option.
 *
 * MCP is served by the shared `omg serve` process rather than a child of each
 * agent (see src/mcp-http.ts), so the endpoint cannot read the caller's identity
 * out of its own environment the way a stdio child could — the caller has to
 * name itself in the URL. A user-scope registration can't: one config file
 * serves every session on the box. So each session re-registers the same
 * endpoint under its own `?session=` URL at launch.
 *
 * The key is the tool namespace the agent sees (`mcp__omg__omg_ship`). It was
 * `lfg` before the rename; sessions already running keep whatever they
 * registered with, and their `lfg_*` calls are aliased at the wire in mcp.ts.
 *
 * Returns nothing outside a managed session, leaving the user-scope
 * registration in charge.
 */
export function omgMcpServers(
  sessionId?: string,
): { mcpServers?: Record<string, { type: "http"; url: string }> } {
  const sid = (sessionId ?? process.env.OMG_SESSION_ID ?? process.env.LFG_SESSION_ID)?.trim();
  if (!sid) return {};
  const url = `${localServeBaseUrl()}/mcp?session=${encodeURIComponent(sid)}`;
  return { mcpServers: { omg: { type: "http", url } } };
}

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
  if (channel === "container") return "redeploy the container to rebuild the image from the current source";
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
