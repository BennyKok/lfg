export type CodingAgentAvailability = {
  key: string;
  visible: boolean;
  status: { configured: boolean };
};

/** Keep agent pickers limited to choices that can actually launch. */
export function configuredAgentOptions<
  T extends { key: string },
>(options: readonly T[], codingAgents?: readonly CodingAgentAvailability[]): T[] {
  // Before bootstrap has returned, preserve the existing choices to avoid a
  // loading-state flash. Once data is present, an empty result stays empty.
  if (codingAgents === undefined) return [...options];
  const available = new Set(
    codingAgents
      .filter((agent) => agent.visible && agent.status.configured)
      .map((agent) => agent.key),
  );
  return options.filter((option) => available.has(option.key));
}
