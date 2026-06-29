export type AgentKind = "claude" | "codex" | "opencode" | "grok";

export type PipelineAgentStep = {
  kind: "agent";
  agent: AgentKind;
  prompt: string;
  model?: string;
  // "transcript_summary" injects the previous agent's output as context.
  // "none" skips context injection (default for the first step).
  context?: "transcript_summary" | "none";
};

export type PipelineRunStep = {
  kind: "run";
  command: string;
};

export type PipelineStep = PipelineAgentStep | PipelineRunStep;

// Raw frontmatter from the .md file.
export type PipelineFrontmatter = {
  name: string;
  title?: string;
  // Working directory (repo path). Defaults to LFG_REPOS_ROOT or cwd.
  cwd?: string;
  steps: Array<
    | {
        agent: AgentKind;
        prompt: string;
        model?: string;
        context?: "transcript_summary" | "none";
      }
    | { run: string }
  >;
};

export type Pipeline = {
  name: string;
  filePath: string;
  frontmatter: PipelineFrontmatter;
  description: string;
  steps: PipelineStep[];
};

// Per-step runtime state.
export type StepState = {
  index: number;
  kind: "agent" | "run";
  status: "pending" | "running" | "done" | "failed";
  startedAt?: number;
  doneAt?: number;
  error?: string;
  // Agent step: tmux session name.
  tmuxName?: string;
  // Agent step: transcript path (resolved after session starts).
  transcriptPath?: string;
  // Agent step: extracted context to pass to the next step.
  contextSummary?: string;
  // Run step: shell exit code.
  exitCode?: number;
  // Log lines emitted during this step.
  log: string[];
};

// A single pipeline execution.
export type PipelineRun = {
  id: string;
  pipeline: string;
  cwd: string;
  startedAt: number;
  status: "running" | "done" | "failed";
  doneAt?: number;
  error?: string;
  steps: StepState[];
};
