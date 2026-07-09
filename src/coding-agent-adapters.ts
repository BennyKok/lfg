import type { CodingAgentKind } from "./coding-agents.ts";

export type CodingAgentTransport = "tmux" | "command-file";

export type CodingAgentAdapter = {
  transport: CodingAgentTransport;
  managedLaunch: true;
};

export const CODING_AGENT_ADAPTERS = {
  claude: { transport: "tmux", managedLaunch: true },
  codex: { transport: "tmux", managedLaunch: true },
  grok: { transport: "tmux", managedLaunch: true },
  cursor: { transport: "tmux", managedLaunch: true },
  aisdk: { transport: "command-file", managedLaunch: true },
  "codex-aisdk": { transport: "command-file", managedLaunch: true },
  opencode: { transport: "command-file", managedLaunch: true },
} as const satisfies Record<Exclude<CodingAgentKind, "hermes">, CodingAgentAdapter>;

export const SESSION_AGENT_KINDS = [
  "claude",
  "aisdk",
  "codex",
  "codex-aisdk",
  "opencode",
  "grok",
  "cursor",
] as const satisfies readonly CodingAgentKind[];

export const TMUX_AGENT_KINDS = [
  "claude",
  "codex",
  "grok",
  "cursor",
] as const satisfies readonly CodingAgentKind[];

export const COMMAND_FILE_AGENT_KINDS = [
  "aisdk",
  "codex-aisdk",
  "opencode",
] as const satisfies readonly CodingAgentKind[];

export function isCommandFileAgent(agent: string | null | undefined): agent is (typeof COMMAND_FILE_AGENT_KINDS)[number] {
  return !!agent && COMMAND_FILE_AGENT_KINDS.includes(agent as (typeof COMMAND_FILE_AGENT_KINDS)[number]);
}

export function isTmuxAgent(agent: string | null | undefined): agent is (typeof TMUX_AGENT_KINDS)[number] {
  return !!agent && TMUX_AGENT_KINDS.includes(agent as (typeof TMUX_AGENT_KINDS)[number]);
}
