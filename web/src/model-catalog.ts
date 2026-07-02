export type AgentKind =
  | "claude"
  | "aisdk"
  | "codex"
  | "codex-aisdk"
  | "opencode"
  | "grok"
  | "hermes";

export type ModelCatalogSource = "static" | "opencode-cli" | "codex-cli" | "hermes-api";

export type ModelCatalogEntry = {
  models: string[];
  defaultModel: string;
  source: ModelCatalogSource;
  error?: string;
};

export type ModelCatalogs = Record<AgentKind, ModelCatalogEntry>;

export type ModelCatalogResponse = {
  catalogs?: Partial<Record<AgentKind, ModelCatalogEntry>>;
};

export const STATIC_MODEL_CATALOGS: ModelCatalogs = {
  claude: { models: ["sonnet", "opus", "haiku", "fable"], defaultModel: "sonnet", source: "static" },
  aisdk: { models: ["opus", "sonnet", "haiku"], defaultModel: "opus", source: "static" },
  codex: { models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"], defaultModel: "gpt-5.5", source: "static" },
  "codex-aisdk": {
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    defaultModel: "gpt-5.5",
    source: "static",
  },
  grok: { models: ["grok-composer-2.5-fast", "grok-build"], defaultModel: "grok-composer-2.5-fast", source: "static" },
  hermes: {
    models: [
      "nousresearch/hermes-4-405b",
      "nousresearch/hermes-4-70b",
      "nousresearch/hermes-3-llama-3.1-405b",
    ],
    defaultModel: "nousresearch/hermes-4-405b",
    source: "static",
  },
  opencode: {
    models: [
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
      "opencode/big-pickle",
    ],
    defaultModel: "opencode-go/deepseek-v4-flash",
    source: "static",
  },
};

const AGENT_KEYS = Object.keys(STATIC_MODEL_CATALOGS) as AgentKind[];

function validEntry(entry: ModelCatalogEntry | undefined): entry is ModelCatalogEntry {
  return !!entry && Array.isArray(entry.models) && entry.models.some((model) => model.trim());
}

export function mergeModelCatalogs(response: ModelCatalogResponse | null | undefined): ModelCatalogs {
  const next: ModelCatalogs = { ...STATIC_MODEL_CATALOGS };

  for (const key of AGENT_KEYS) {
    const entry = response?.catalogs?.[key];
    if (!validEntry(entry)) continue;

    const models = [...new Set(entry.models.map((model) => model.trim()).filter(Boolean))];
    if (!models.length) continue;

    next[key] = {
      models,
      defaultModel: models.includes(entry.defaultModel) ? entry.defaultModel : models[0],
      source: entry.source,
      error: entry.error,
    };
  }

  return next;
}

export function modelsForAgent(catalogs: ModelCatalogs, agent: AgentKind): string[] {
  return catalogs[agent]?.models ?? STATIC_MODEL_CATALOGS[agent].models;
}

export function defaultModelForAgent(catalogs: ModelCatalogs, agent: AgentKind): string {
  return catalogs[agent]?.defaultModel ?? STATIC_MODEL_CATALOGS[agent].defaultModel;
}

export function fallbackModelsForAgent(agent: AgentKind): string[] {
  return STATIC_MODEL_CATALOGS[agent].models;
}
