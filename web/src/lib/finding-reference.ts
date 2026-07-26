export type FindingReferenceInput = {
  id: string;
  title: string;
  reasoning: string[];
  suggest?: string;
};

export function findingReference(
  finding: FindingReferenceInput,
  agentName: string,
): string {
  return [
    `LFG auto finding reference: ${finding.id}`,
    `Agent: ${agentName}`,
    `Title: ${finding.title}`,
    ...(finding.reasoning.length
      ? ["", "Reasoning:", ...finding.reasoning.map((reason) => `- ${reason}`)]
      : []),
    ...(finding.suggest ? ["", `Suggested fix: ${finding.suggest}`] : []),
  ].join("\n");
}
