import type { Agent } from "./agents/registry.ts";
import type { AutoAgent } from "./auto/store.ts";
import type { CodingAgentInfo, CodingAgentKind } from "./coding-agents.ts";
import { discoveredModelIdsByProviderSync, readModelDiscoveryCacheSync } from "./model-discovery.ts";
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
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];
export const AISDK_MODELS: string[] = ["fable", "opus", "sonnet", "haiku"];
export const CODEX_AISDK_MODELS: string[] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];
export const GROK_MODELS: string[] = ["grok-4.5", "grok-composer-2.5-fast"];
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

export const AUTO_AGENT_BACKENDS = [
  "aisdk",
  "codex-aisdk",
  "grok",
  "cursor",
  "opencode",
] as const;
export type AutoAgentBackend = (typeof AUTO_AGENT_BACKENDS)[number];
const MODEL_CATALOG_KEYS: CodingAgentKind[] = [
  "claude",
  "aisdk",
  "codex",
  "codex-aisdk",
  "grok",
  "cursor",
  "opencode",
];

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
  codex: { defaultModel: "gpt-5.6-sol", models: CODEX_MODELS },
  "codex-aisdk": { defaultModel: "gpt-5.6-sol", models: CODEX_AISDK_MODELS },
  grok: { defaultModel: "grok-4.5", models: GROK_MODELS },
  cursor: { defaultModel: "auto", models: CURSOR_MODELS },
  hermes: { defaultModel: "nousresearch/hermes-4-405b", models: HERMES_MODELS },
  opencode: { defaultModel: "opencode-go/deepseek-v4-flash", models: OPENCODE_MODELS },
};

function mergeModels(...sets: Array<readonly string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const set of sets) {
    for (const model of set ?? []) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      out.push(model);
    }
  }
  return out;
}

const CURSOR_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const CURSOR_LEVEL_ALIASES: Record<string, string> = {
  "extra-high": "xhigh",
  xhigh: "xhigh",
  max: "max",
  high: "high",
  medium: "medium",
  low: "low",
  minimal: "minimal",
  none: "none",
};

type CursorVariant = {
  raw: string;
  base: string;
  level?: string;
  fast: boolean;
};

function parseCursorVariant(raw: string): CursorVariant {
  let base = raw;
  let fast = false;
  let level: string | undefined;

  const stripFast = () => {
    if (base.endsWith("-fast")) {
      base = base.slice(0, -"-fast".length);
      fast = true;
    }
  };
  const stripLevel = () => {
    const thinkingFirst = base.match(/-thinking-(none|minimal|low|medium|high|xhigh|max)$/);
    if (thinkingFirst) {
      level = CURSOR_LEVEL_ALIASES[thinkingFirst[1]];
      base = base.slice(0, -thinkingFirst[0].length);
      return true;
    }
    const thinkingLast = base.match(/-(none|minimal|low|medium|high|xhigh|max)-thinking$/);
    if (thinkingLast) {
      level = CURSOR_LEVEL_ALIASES[thinkingLast[1]];
      base = base.slice(0, -thinkingLast[0].length);
      return true;
    }
    const extraHigh = base.match(/-extra-high$/);
    if (extraHigh) {
      level = "xhigh";
      base = base.slice(0, -extraHigh[0].length);
      return true;
    }
    const plain = base.match(/-(none|minimal|low|medium|high|xhigh|max)$/);
    if (plain) {
      level = CURSOR_LEVEL_ALIASES[plain[1]];
      base = base.slice(0, -plain[0].length);
      return true;
    }
    return false;
  };

  stripFast();
  stripLevel();
  stripFast();
  base = base.replace(/^claude-opus-(\d+)\.(\d+)$/, "claude-opus-$1-$2");
  return { raw, base, level, fast };
}

function numberParts(value: string): number[] {
  return (value.match(/\d+(?:\.\d+)*/g) ?? [])
    .flatMap((part) => part.split(".").map((item) => parseInt(item, 10)))
    .filter((item) => Number.isFinite(item));
}

function compareModelVersion(a: string, b: string): number {
  const av = numberParts(a);
  const bv = numberParts(b);
  const n = Math.max(av.length, bv.length);
  for (let i = 0; i < n; i++) {
    const diff = (av[i] ?? -1) - (bv[i] ?? -1);
    if (diff) return diff;
  }
  return a.localeCompare(b);
}

function latest(items: string[]): string | undefined {
  return [...new Set(items)].sort((a, b) => compareModelVersion(b, a))[0];
}

function addLatest(out: string[], candidates: string[]) {
  const picked = latest(candidates);
  if (picked && !out.includes(picked)) out.push(picked);
}

function curateCursorModels(models: string[]): string[] {
  const variants = models.map(parseCursorVariant);
  const bases = [...new Set(variants.map((item) => item.base))];
  const out: string[] = [];
  const add = (model: string | undefined) => {
    if (model && bases.includes(model) && !out.includes(model)) out.push(model);
  };

  add("auto");
  addLatest(out, bases.filter((m) => /^gpt-\d/.test(m) && !m.includes("codex") && !/-(mini|nano)$/.test(m)));
  addLatest(out, bases.filter((m) => /^gpt-\d/.test(m) && m.includes("codex") && !m.includes("mini")));
  addLatest(out, bases.filter((m) => /^gpt-\d/.test(m) && m.includes("mini")));
  addLatest(out, bases.filter((m) => /^grok-\d/.test(m)));
  addLatest(out, bases.filter((m) => /^claude-fable/.test(m)));
  addLatest(out, bases.filter((m) => /claude.*sonnet/.test(m)));
  addLatest(out, bases.filter((m) => /claude.*opus/.test(m)));
  addLatest(out, bases.filter((m) => /^gemini-.*pro/.test(m)));
  addLatest(out, bases.filter((m) => /^kimi-.*code/.test(m) || /^kimi-k/.test(m)));
  addLatest(out, bases.filter((m) => /^glm-\d/.test(m)));
  addLatest(out, bases.filter((m) => /^composer-\d/.test(m)));

  for (const fallback of ["gpt-5.5", "claude-opus-4-8", "gemini-3.1-pro", "composer-2.5"]) add(fallback);
  return out.length ? out : models;
}

function opencodeFamily(model: string): string | null {
  const id = model.split("/").pop() ?? model;
  if (/deepseek-v\d/i.test(id)) return id.includes("flash") ? "deepseek-flash" : "deepseek-pro";
  if (/^glm-\d/i.test(id)) return "glm";
  if (/kimi-k/i.test(id)) return id.includes("code") ? "kimi-code" : "kimi";
  if (/qwen3.*max/i.test(id)) return "qwen-max";
  if (/qwen3.*plus/i.test(id)) return "qwen-plus";
  if (/minimax-m/i.test(id)) return "minimax";
  if (/mimo-v/i.test(id)) return id.includes("pro") ? "mimo-pro" : "mimo";
  if (/fugu-ultra/i.test(id)) return "fugu-ultra";
  if (/fugu$/i.test(id)) return "fugu";
  return null;
}

function curateOpenCodeModels(models: string[]): string[] {
  const preferred = models.filter((model) =>
    /^(opencode-go|fugu|sakana)\//.test(model) ||
    /^novita-ai\/(deepseek|moonshotai|qwen|zai-org|minimax|minimaxai|xiaomimimo)\//.test(model),
  );
  const byFamily = new Map<string, string[]>();
  for (const model of preferred) {
    const family = opencodeFamily(model);
    if (!family) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), model]);
  }
  const order = [
    "deepseek-pro",
    "deepseek-flash",
    "glm",
    "kimi-code",
    "qwen-max",
    "qwen-plus",
    "minimax",
    "mimo-pro",
    "fugu-ultra",
    "fugu",
  ];
  const out: string[] = [];
  for (const family of order) addLatest(out, byFamily.get(family) ?? []);
  return out.length ? out : models.slice(0, 16);
}

function curateCodexModels(models: string[]): string[] {
  const out: string[] = [];
  const add = (model: string) => {
    if (models.includes(model) && !out.includes(model)) out.push(model);
  };

  for (const model of CODEX_MODELS) add(model);
  addLatest(out, models.filter((m) => /^gpt-\d/.test(m) && !m.includes("codex") && !m.includes("mini")));
  addLatest(out, models.filter((m) => /^gpt-\d/.test(m) && m.includes("mini")));
  addLatest(out, models.filter((m) => /^gpt-\d/.test(m) && m.includes("codex") && !m.includes("spark")));
  addLatest(out, models.filter((m) => m.includes("spark")));
  for (const fallback of CODEX_MODELS) if (!out.includes(fallback) && models.includes(fallback)) out.push(fallback);
  return out.length ? out : models;
}

function curateGrokModels(models: string[]): string[] {
  const out: string[] = [];
  const add = (model: string) => {
    if (models.includes(model) && !out.includes(model)) out.push(model);
  };

  for (const model of GROK_MODELS) add(model);
  addLatest(out, models.filter((m) => /^grok-\d/.test(m)));
  addLatest(out, models.filter((m) => /^grok-composer/.test(m)));
  addLatest(out, models.filter((m) => /^grok-build/.test(m)));
  for (const model of models) add(model);
  return out.length ? out : models;
}

function curateModels(agent: CodingAgentKind, models: string[]): string[] {
  if (agent === "cursor") return curateCursorModels(models);
  if (agent === "opencode") return curateOpenCodeModels(models);
  if (agent === "codex" || agent === "codex-aisdk") return curateCodexModels(models);
  if (agent === "grok") return curateGrokModels(models);
  return models;
}

export function rawModelsForAgent(agent: CodingAgentKind): string[] {
  const fallback = MODEL_OPTIONS[agent]?.models;
  const provider = readModelDiscoveryCacheSync()?.providers?.[agent];
  const discovered = discoveredModelIdsByProviderSync();
  return mergeModels(fallback, provider?.ok ? provider.models : undefined, discovered[agent]);
}

export function modelsForAgent(agent: CodingAgentKind): string[] {
  return curateModels(agent, rawModelsForAgent(agent));
}

export function resolveModelForAgent(
  agent: CodingAgentKind,
  model: string | undefined,
  thinkingLevel?: string,
): string | undefined {
  if (!model) return undefined;
  if (agent !== "cursor" || model === "auto") return model;
  const raw = rawModelsForAgent("cursor");
  if (raw.includes(model)) return model;
  const requestedLevel = thinkingLevel ? CURSOR_LEVEL_ALIASES[thinkingLevel] ?? thinkingLevel : undefined;
  const variants = raw.map(parseCursorVariant).filter((item) => item.base === model);
  if (!variants.length) return model;
  const score = (item: CursorVariant) => {
    let value = item.fast ? 0 : 4;
    if (requestedLevel && item.level === requestedLevel) value += 100;
    if (!requestedLevel && !item.level) value += 80;
    if (!requestedLevel && item.level === "high") value += 60;
    if (requestedLevel === "xhigh" && item.level === "xhigh") value += 20;
    if (requestedLevel === "xhigh" && item.level === "max") value += 12;
    if (requestedLevel === "high" && item.level === "medium") value += 8;
    if (!item.level) value += 2;
    return value;
  };
  return [...variants].sort((a, b) => score(b) - score(a))[0]?.raw ?? model;
}

export function thinkingLevelsForAgent(agent: string): readonly string[] | null {
  if (agent === "claude" || agent === "aisdk" || agent === "grok") return CLAUDE_THINKING_LEVELS;
  if (agent === "codex" || agent === "codex-aisdk") return CODEX_THINKING_LEVELS;
  if (agent === "cursor") return CURSOR_THINKING_LEVELS;
  return null;
}

export function listModelCatalog(codingAgents: CodingAgentInfo[] = []): ModelCatalogItem[] {
  const configured = new Map(codingAgents.map((agent) => [agent.key, agent]));
  return MODEL_CATALOG_KEYS.map((key) => {
    const status = configured.get(key);
    const models = modelsForAgent(key);
    return {
      key,
      label: LABELS[key],
      defaultModel: models.includes(MODEL_OPTIONS[key].defaultModel)
        ? MODEL_OPTIONS[key].defaultModel
        : models[0] ?? MODEL_OPTIONS[key].defaultModel,
      models,
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
