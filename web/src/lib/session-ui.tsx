// Small pieces shared between App.tsx and the route-level views that load from
// their own chunks.
//
// They live here rather than travelling into a lazy view because App.tsx needs
// them too: a static import back into App from a lazy module would pull that
// module's whole graph into the entry chunk, which is exactly how a code split
// ends up saving nothing.
import { createContext, useContext, useMemo } from "react";
import type { ClaudeAccountInfo, CodingAgentInfo, Session } from "../App";
import { lfgAssetUrl } from "./lfg-client";
import { cn } from "./utils";

export const AGENT_ICON_VERSION = "20260718";

/**
 * The session-card / picker icon for an agent kind. Codex variants share the
 * codex mark; claude variants (including aisdk) share the claude mark.
 */
export function agentIconSrc(agent?: string): string {
  const v = `?v=${AGENT_ICON_VERSION}`;
  if (agent === "codex" || agent === "codex-aisdk") return lfgAssetUrl(`/agent-codex.svg${v}`);
  if (agent === "grok") return lfgAssetUrl(`/agent-grok.svg${v}`);
  if (agent === "cursor") return lfgAssetUrl(`/agent-cursor.svg${v}`);
  if (agent === "hermes") return lfgAssetUrl(`/agent-hermes.svg${v}`);
  if (agent === "opencode") return lfgAssetUrl(`/agent-opencode.svg${v}`);
  if (agent === "pi") return lfgAssetUrl(`/agent-pi.svg${v}`);
  if (agent === "copilot") return lfgAssetUrl(`/agent-copilot.svg${v}`);
  return lfgAssetUrl(`/agent-claude.svg${v}`);
}

export function agentIconAlt(agent?: string): string {
  if (agent === "codex" || agent === "codex-aisdk") return "Codex";
  if (agent === "grok") return "Grok";
  if (agent === "cursor") return "Cursor";
  if (agent === "hermes") return "Hermes";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "pi";
  if (agent === "copilot") return "Copilot";
  return "Claude";
}

export function timeAgo(value?: number | null): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Opening an artifact never leaves the app or pops a window: cards push onto a
 * full-screen in-app page with a Back header.
 */
export type ViewerArtifact = {
  url: string;
  kind: "image" | "video" | "html";
  title?: string;
  caption?: string;
  name?: string;
  version?: number;
  // Changes on every successful content write, including data-only refreshes.
  // Kept separate from the user-facing authored revision.
  cacheKey?: number;
};

export const ArtifactViewerContext = createContext<(artifact: ViewerArtifact) => void>(() => {});

/** Page sizes for the shipped feed and the artifact gallery. */
export const FEED_PAGE = 15;
export const GALLERY_PAGE = 24;

/** The name a session shows in every surface that has to label one. */
export function titleForSession(session: Session): string {
  return (
    session.title ||
    session.lastUserText ||
    session.tmuxName ||
    session.project ||
    session.sessionId?.slice(0, 8) ||
    "session"
  );
}

/** Agent kinds whose CLI login can be driven from the browser (see
 *  authProviderFor in src/coding-agents.ts). Everything else is terminal-only. */
export const BROWSER_AUTH_KINDS = new Set<string>([
  "claude",
  "aisdk",
  "codex",
  "codex-aisdk",
  "grok",
]);

export const CodingAgentsContext = createContext<CodingAgentInfo[] | undefined>(undefined);

/** Every connected Claude account, numbered — empty when there is only one to tell apart. */
export function useNumberedClaudeAccounts(): ClaudeAccountInfo[] {
  const codingAgents = useContext(CodingAgentsContext);
  return useMemo(() => {
    const accounts = codingAgents
      ?.find((agent) => agent.key === "aisdk")
      ?.status.accounts?.filter((account) => account.connected);
    return accounts && accounts.length > 1 ? accounts : [];
  }, [codingAgents]);
}

/** The account number to stamp on a Claude mark, or null when there is nothing to disambiguate. */
export function useClaudeAccountNumber(
  agent: string | undefined,
  claudeAccountId: string | null | undefined,
): number | null {
  const accounts = useNumberedClaudeAccounts();
  if (!claudeAccountId) return null;
  // Only the Claude marks are ambiguous; every other agent has one identity.
  if (agent && agent !== "aisdk" && agent !== "claude") return null;
  return accounts.find((account) => account.id === claudeAccountId)?.number ?? null;
}

/**
 * The account number worn by a Claude icon, so a fleet split across several
 * logins is readable without opening anything. Always bottom-right — the same
 * corner the agent pickers and the usage campfire use.
 */
export function ClaudeAccountBadge({
  number,
  size = "md",
  className,
}: {
  number: number | null;
  size?: "sm" | "md";
  className?: string;
}) {
  if (number == null) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-foreground font-bold leading-none text-background ring-1 ring-background",
        size === "sm" ? "size-3 text-[7px]" : "size-3.5 text-[8px]",
        className,
      )}
    >
      {number}
    </span>
  );
}

/** A session's agent mark, wearing its Claude account number when it has one. */
export function SessionAgentIcon({
  session,
  className,
  size,
  wrapperClassName,
}: {
  session: Pick<Session, "agent" | "agentLabel" | "claudeAccountId">;
  className?: string;
  size?: "sm" | "md";
  wrapperClassName?: string;
}) {
  const number = useClaudeAccountNumber(session.agent, session.claudeAccountId);
  const label = session.agentLabel || agentIconAlt(session.agent);
  const img = (
    <img
      src={agentIconSrc(session.agent)}
      alt={number == null ? label : `${label} ${number}`}
      title={session.agentLabel || undefined}
      className={className}
    />
  );
  // Without a number there is nothing to position against, so the extra
  // wrapper element is skipped entirely.
  if (number == null && !wrapperClassName) return img;
  return (
    <span className={cn("relative inline-flex shrink-0", wrapperClassName)}>
      {img}
      <ClaudeAccountBadge number={number} size={size} />
    </span>
  );
}
