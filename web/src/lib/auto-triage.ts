import { findingReference, type FindingReferenceInput } from "./finding-reference";

export type AutoTriageAgent = {
  id: string;
  name: string;
  cwd?: string;
  project?: string;
};

export type AutoTriageFinding = FindingReferenceInput & {
  agentId: string;
  severity: "high" | "med" | "low";
};

export function buildAutoTriagePrompt(
  findings: AutoTriageFinding[],
  agents: AutoTriageAgent[],
): string {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const snapshot = findings.map((finding) => {
    const source = agentsById.get(finding.agentId);
    const sourceName = source?.name ?? finding.agentId;
    const repo = source?.cwd
      ? `\nSource repo: ${source.cwd}${source.project ? ` (project ${source.project})` : ""}`
      : "";
    return `${findingReference(finding, sourceName)}\nSeverity: ${finding.severity}${repo}`;
  });

  return [
    `Triage and execute ${findings.length} open LFG auto-agent finding${findings.length === 1 ? "" : "s"}.`,
    "",
    "The human explicitly started the Triage & execute shortcut. This authorizes you to delegate actionable implementation work to linked LFG subagents. The scheduled auto agents have already run; do not just rerun every watcher.",
    "",
    "Workflow:",
    "1. Refresh the open findings with `lfg agents auto findings --status open --json`, then verify each claim against current code, runtime state, and recent work before acting. The finding ids in the snapshot below define this run's scope; use the refresh to remove stale items, not to pull unrelated findings into a project-scoped run.",
    "2. Group findings that share a root cause, repository, deployment surface, or likely file overlap. Keep unrelated or conflicting work in separate groups.",
    "3. Dismiss a finding only when evidence shows it is already resolved, duplicated, or purely informational. Use `lfg agents auto dismiss <findingId>` and record the evidence.",
    "4. Execute every safe, actionable group now by creating linked, visible LFG subagent sessions in the correct repo/worktree. Give each child the complete finding ids and context, require reproduction before edits, focused tests, repository instructions, deployment verification when applicable, and dismissal only after the fix is verified.",
    "5. Keep pricing, product-direction, destructive, irreversible, or genuinely ambiguous decisions open for the human. Explain the exact decision needed instead of inventing approval.",
    "6. Monitor the delegated sessions through completion. Do not stop after writing a triage plan or launching children; report final results, commits/PRs, verification, dismissed findings, and anything still open.",
    "",
    "Use LFG-managed delegation tools so every child remains linked to this parent session. Respect available concurrency and batch related findings instead of creating one child per finding.",
    "",
    "Finding snapshot captured when the shortcut was pressed (the live refresh above is authoritative):",
    "",
    ...snapshot.flatMap((entry, index) => [entry, ...(index < snapshot.length - 1 ? ["", "---", ""] : [])]),
  ].join("\n");
}
