export type CodingAgentAvailability = {
  key: string;
  visible: boolean;
  status: { configured: boolean; accountConnected?: boolean };
};

export type AgentAccessMode = "configured" | "connected-or-opencode";

/** Keep agent pickers limited to choices that can actually launch. */
export function configuredAgentOptions<
  T extends { key: string },
>(
  options: readonly T[],
  codingAgents?: readonly CodingAgentAvailability[],
  accessMode: AgentAccessMode = "configured",
): T[] {
  // Before bootstrap has returned, preserve the existing choices to avoid a
  // loading-state flash. Hosted surfaces are the exception: their runtime
  // proxy keys are not user-owned access, so only the anonymous OpenCode path
  // is safe to advertise until account state arrives.
  if (codingAgents === undefined) {
    return accessMode === "connected-or-opencode"
      ? options.filter((option) => option.key === "opencode")
      : [...options];
  }
  const available = new Set(
    codingAgents
      .filter(
        (agent) =>
          agent.visible &&
          agent.status.configured &&
          (accessMode === "configured" ||
            agent.key === "opencode" ||
            agent.status.accountConnected === true),
      )
      .map((agent) => agent.key),
  );
  return options.filter((option) => available.has(option.key));
}
