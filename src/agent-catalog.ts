import type { Agent } from "./agents/registry.ts";
import type { AutoAgent } from "./auto/store.ts";
import type { CodingAgentInfo, CodingAgentKind } from "./coding-agents.ts";
import type { Session } from "./sessions.ts";

export type SkillCatalogItem = {
  name: string;
  trigger: string;
  description: string;
  keywords: string;
  source: "codex" | "claude" | "agent";
  path: string;
};

export const CLAUDE_MODELS: string[] = ["fable", "opus", "sonnet", "haiku"];
export const CODEX_MODELS: string[] = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];
export const AISDK_MODELS: string[] = ["fable", "opus", "sonnet", "haiku"];
export const CODEX_AISDK_MODELS: string[] = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];
export const GROK_MODELS: string[] = ["grok-composer-2.5-fast", "grok-build"];
export const CURSOR_MODELS: string[] = [
  "auto",
  "composer-2.5",
  "gpt-5",
  "gpt-5.5",
  "claude-opus-4.8",
  "gemini-3.1-pro",
  "grok-4.3",
];
export const HERMES_MODELS: string[] = [
  "nousresearch/hermes-4-405b",
  "nousresearch/hermes-4-70b",
  "nousresearch/hermes-3-llama-3.1-405b",
];
export const OPENCODE_MODELS: string[] = [
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
];

export const AUTO_AGENT_BACKENDS = ["aisdk", "codex-aisdk", "opencode", "hermes"] as const;
export type AutoAgentBackend = (typeof AUTO_AGENT_BACKENDS)[number];

export const CODEX_THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export const CLAUDE_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PICKER_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export type ModelCatalogItem = {
  key: CodingAgentKind;
  label: string;
  defaultModel: string;
  models: string[];
  thinkingLevels: string[];
  session: boolean;
  auto: boolean;
  visible?: boolean;
  configured?: boolean;
};

const LABELS: Record<CodingAgentKind, string> = {
  claude: "claude",
  aisdk: "claude",
  codex: "codex",
  "codex-aisdk": "codex",
  opencode: "opencode",
  grok: "grok",
  cursor: "cursor",
  hermes: "hermes",
};

export const MODEL_OPTIONS: Record<CodingAgentKind, { defaultModel: string; models: readonly string[] }> = {
  claude: { defaultModel: "sonnet", models: CLAUDE_MODELS },
  aisdk: { defaultModel: "opus", models: AISDK_MODELS },
  codex: { defaultModel: "gpt-5.5", models: CODEX_MODELS },
  "codex-aisdk": { defaultModel: "gpt-5.5", models: CODEX_AISDK_MODELS },
  grok: { defaultModel: "grok-composer-2.5-fast", models: GROK_MODELS },
  cursor: { defaultModel: "auto", models: CURSOR_MODELS },
  hermes: { defaultModel: "nousresearch/hermes-4-405b", models: HERMES_MODELS },
  opencode: { defaultModel: "opencode-go/deepseek-v4-flash", models: OPENCODE_MODELS },
};

export function thinkingLevelsForAgent(agent: string): readonly string[] | null {
  if (agent === "claude" || agent === "aisdk" || agent === "grok") return CLAUDE_THINKING_LEVELS;
  if (agent === "codex" || agent === "codex-aisdk") return CODEX_THINKING_LEVELS;
  return null;
}

export function listModelCatalog(codingAgents: CodingAgentInfo[] = []): ModelCatalogItem[] {
  const configured = new Map(codingAgents.map((agent) => [agent.key, agent]));
  return (Object.keys(MODEL_OPTIONS) as CodingAgentKind[]).map((key) => {
    const status = configured.get(key);
    return {
      key,
      label: LABELS[key],
      defaultModel: MODEL_OPTIONS[key].defaultModel,
      models: [...MODEL_OPTIONS[key].models],
      thinkingLevels: [...(thinkingLevelsForAgent(key) ?? [])],
      session: key !== "claude" && key !== "codex",
      auto: (AUTO_AGENT_BACKENDS as readonly string[]).includes(key),
      visible: status?.visible,
      configured: status?.status.configured,
    };
  });
}

export type AgentBrowserTree = {
  models: ModelCatalogItem[];
  skills: SkillCatalogItem[];
  insightAgents: Array<{
    name: string;
    title: string;
    enabled: boolean;
    inputs: string[];
    skills: string[];
    path: string;
  }>;
  autoAgents: Array<{
    id: string;
    name: string;
    enabled: boolean;
    backend: AutoAgentBackend;
    model?: string;
    schedule: string;
    cwd?: string;
    skills: string[];
    lastRunAt?: number;
  }>;
  runtimeSessions: Array<{
    sessionId: string;
    nativeSessionId?: string | null;
    title: string;
    agent: string;
    model?: string | null;
    project: string;
    parentSessionId?: string | null;
    parentNativeSessionId?: string | null;
    parentAgent?: string | null;
    spawnedBy?: string | null;
    busy?: boolean;
  }>;
  groups: {
    providers: Array<{
      key: string;
      label: string;
      defaultModel: string;
      models: string[];
      autoAgents: string[];
      insightAgents: string[];
    }>;
    skills: Array<{
      trigger: string;
      source: string;
      autoAgents: string[];
      insightAgents: string[];
    }>;
    runtimeParents: Array<{
      parentSessionId: string;
      children: string[];
    }>;
  };
};

function skillRefs(text: string, skills: SkillCatalogItem[]): string[] {
  const refs = new Set<string>();
  for (const skill of skills) {
    const escaped = skill.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\$${escaped}(?=\\s|$|[.,;:)\\]])`).test(text)) refs.add(skill.trigger);
  }
  return [...refs].sort((a, b) => a.localeCompare(b));
}

export function buildAgentBrowserTree(input: {
  skills: SkillCatalogItem[];
  insightAgents: Agent[];
  autoAgents: AutoAgent[];
  codingAgents?: CodingAgentInfo[];
  sessions?: Session[];
}): AgentBrowserTree {
  const models = listModelCatalog(input.codingAgents);
  const insightAgents = input.insightAgents.map((agent) => ({
    name: agent.name,
    title: agent.frontmatter.title ?? agent.name,
    enabled: agent.frontmatter.enabled !== false,
    inputs: (agent.frontmatter.inputs ?? []).map((item) => item.kind),
    skills: skillRefs(agent.raw, input.skills),
    path: agent.filePath,
  }));
  const autoAgents = input.autoAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    backend: (agent.agent ?? "aisdk") as AutoAgentBackend,
    model: agent.model,
    schedule: agent.schedule,
    cwd: agent.cwd,
    skills: skillRefs(agent.prompt, input.skills),
    lastRunAt: agent.lastRunAt,
  }));
  const runtimeSessions = (input.sessions ?? [])
    .filter((session) => !!session.sessionId)
    .map((session) => ({
      sessionId: session.sessionId!,
      nativeSessionId: session.nativeSessionId,
      title: session.title,
      agent: session.agent,
      model: session.model,
      project: session.project,
      parentSessionId: session.parentSessionId,
      parentNativeSessionId: session.parentNativeSessionId,
      parentAgent: session.parentAgent,
      spawnedBy: session.spawnedBy,
      busy: session.busy,
    }));
  const childrenByParent = new Map<string, string[]>();
  for (const session of runtimeSessions) {
    const parent = session.parentSessionId ?? session.parentNativeSessionId;
    if (!parent) continue;
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), session.sessionId]);
  }
  return {
    models,
    skills: input.skills,
    insightAgents,
    autoAgents,
    runtimeSessions,
    groups: {
      providers: models.map((model) => ({
        key: model.key,
        label: model.label,
        defaultModel: model.defaultModel,
        models: model.models,
        autoAgents: autoAgents
          .filter((agent) => agent.backend === model.key)
          .map((agent) => agent.id),
        insightAgents: insightAgents
          .filter((agent) => agent.title.toLowerCase().includes(model.label.toLowerCase()))
          .map((agent) => agent.name),
      })),
      skills: input.skills.map((skill) => ({
        trigger: skill.trigger,
        source: skill.source,
        autoAgents: autoAgents
          .filter((agent) => agent.skills.includes(skill.trigger))
          .map((agent) => agent.id),
        insightAgents: insightAgents
          .filter((agent) => agent.skills.includes(skill.trigger))
          .map((agent) => agent.name),
      })),
      runtimeParents: [...childrenByParent.entries()].map(([parentSessionId, children]) => ({
        parentSessionId,
        children,
      })),
    },
  };
}
