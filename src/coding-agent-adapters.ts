import type { CodingAgentKind } from "./coding-agents.ts";

export type CodingAgentTransport = "tmux" | "command-file";

export type CodingAgentAdapter = {
  transport: CodingAgentTransport;
  managedLaunch: true;
  /**
   * durable: a dead agent process can be relaunched from persisted history.
   * process-bound: LFG can rediscover the live process after serve restarts,
   * but cannot recreate the provider conversation after that process dies.
   */
  recovery: "durable" | "process-bound";
};

export const CODING_AGENT_ADAPTERS = {
  claude: { transport: "tmux", managedLaunch: true, recovery: "durable" },
  codex: { transport: "tmux", managedLaunch: true, recovery: "durable" },
  grok: { transport: "tmux", managedLaunch: true, recovery: "durable" },
  cursor: { transport: "tmux", managedLaunch: true, recovery: "durable" },
  copilot: { transport: "tmux", managedLaunch: true, recovery: "process-bound" },
  aisdk: { transport: "command-file", managedLaunch: true, recovery: "durable" },
  "codex-aisdk": { transport: "command-file", managedLaunch: true, recovery: "durable" },
  opencode: { transport: "command-file", managedLaunch: true, recovery: "durable" },
  pi: { transport: "command-file", managedLaunch: true, recovery: "durable" },
} as const satisfies Record<Exclude<CodingAgentKind, "hermes">, CodingAgentAdapter>;

export const SESSION_AGENT_KINDS = [
  "claude",
  "aisdk",
  "codex",
  "codex-aisdk",
  "opencode",
  "grok",
  "cursor",
  "pi",
  "copilot",
] as const satisfies readonly CodingAgentKind[];

export const TMUX_AGENT_KINDS = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "copilot",
] as const satisfies readonly CodingAgentKind[];

export const COMMAND_FILE_AGENT_KINDS = [
  "aisdk",
  "codex-aisdk",
  "opencode",
  "pi",
] as const satisfies readonly CodingAgentKind[];

export const DURABLE_RECOVERY_AGENT_KINDS = SESSION_AGENT_KINDS.filter(
  (agent) => CODING_AGENT_ADAPTERS[agent].recovery === "durable",
);

export function isCommandFileAgent(agent: string | null | undefined): agent is (typeof COMMAND_FILE_AGENT_KINDS)[number] {
  return !!agent && COMMAND_FILE_AGENT_KINDS.includes(agent as (typeof COMMAND_FILE_AGENT_KINDS)[number]);
}

export function isTmuxAgent(agent: string | null | undefined): agent is (typeof TMUX_AGENT_KINDS)[number] {
  return !!agent && TMUX_AGENT_KINDS.includes(agent as (typeof TMUX_AGENT_KINDS)[number]);
}
