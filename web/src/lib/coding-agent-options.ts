export type CodingAgentAvailability = {
  key: string;
  visible: boolean;
  status: { configured: boolean; accountConnected?: boolean };
};

export type AgentAccessMode = "configured" | "connected-or-opencode";

/**
 * Resolve the agent icon/label while the configured roster is still loading.
 *
 * The selected agent state is authoritative even before bootstrap supplies the
 * launchable subset. Falling back to the first catalog entry in that window
 * briefly painted Claude for a saved OpenCode selection.
 */
export function displayedAgentOption<T extends { key: string; selectorId?: string }>(
  catalog: readonly T[],
  visible: readonly T[],
  agent: string,
  selectedId: string,
): T | undefined {
  return (
    visible.find((option) => (option.selectorId ?? option.key) === selectedId) ??
    visible.find((option) => option.key === agent) ??
    visible[0] ??
    catalog.find((option) => option.key === agent) ??
    catalog[0]
  );
}

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
