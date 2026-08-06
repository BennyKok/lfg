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

export type AutoTriageRepo = { cwd: string; project: string };

// One entry per finding in scope: where its auto agent ran, and the project the
// UI already groups that finding under (server-computed and worktree-aware).
export type AutoTriageSource = { cwd?: string; project?: string };

// Pick the cwd for the triage session so it lands in the SAME project folder the
// findings are listed under. The rail/Live list groups sessions by project, so a
// triage run launched into the last-used repo simply disappears from the view
// the human pressed the button in.
export function resolveAutoTriageCwd(input: {
  sources: AutoTriageSource[];
  projectFilter: string;
  repos: AutoTriageRepo[];
  fallbackCwd?: string | null;
}): string | undefined {
  const { sources, projectFilter, repos, fallbackCwd } = input;
  const projects = Array.from(
    new Set(sources.map((source) => source.project).filter((p): p is string => !!p)),
  );
  // A single shared project wins over the filter: the Auto tab triages every
  // finding regardless of the selected filter. Otherwise an explicitly selected
  // project keeps a mixed batch inside the folder being looked at.
  const target =
    projects.length === 1 ? projects[0] : projectFilter !== "__all" ? projectFilter : undefined;

  const cwdsFor = (match?: string) =>
    Array.from(
      new Set(
        sources
          .filter((source) => (match ? source.project === match : true))
          .map((source) => source.cwd)
          .filter((cwd): cwd is string => !!cwd),
      ),
    );

  if (target) {
    // Prefer the exact agent cwd when the whole group ran in one place (it may be
    // a worktree of the target project, which still groups under that project).
    const scoped = cwdsFor(target);
    if (scoped.length === 1) return scoped[0];
    const repo = repos.find((r) => r.project === target);
    if (repo) return repo.cwd;
    if (scoped.length) return scoped[0];
  } else {
    const all = cwdsFor();
    if (all.length === 1) return all[0];
  }

  return fallbackCwd || repos[0]?.cwd;
}

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
