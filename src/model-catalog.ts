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

export type ModelCatalogResponse = {
  catalogs: Record<AgentKind, ModelCatalogEntry>;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (cmd: string[]) => Promise<CommandResult>;

export const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"];
export const CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
export const AISDK_MODELS = ["opus", "sonnet", "haiku"];
export const GROK_MODELS = ["grok-composer-2.5-fast", "grok-build"];
export const GROK_DEFAULT_MODEL = "grok-composer-2.5-fast";
export const HERMES_MODELS = [
  "nousresearch/hermes-4-405b",
  "nousresearch/hermes-4-70b",
  "nousresearch/hermes-3-llama-3.1-405b",
];
export const HERMES_DEFAULT_MODEL = "nousresearch/hermes-4-405b";
export const OPENCODE_MODELS = [
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
];
export const OPENCODE_DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
export const OPENCODE_DISABLED_MODELS = new Set<string>([
  "fugu/fugu",
  "fugu/fugu-ultra",
  "fugu",
  "fugu-ultra",
  "novita-ai/deepseek/deepseek-v4-pro",
  "novita-ai/zai-org/glm-5.2",
  "novita-ai/zai-org/glm-5.1",
]);

const MODEL_NAME_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const OPENCODE_MODEL_RE = /^(?=.{1,80}$)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function staticEntry(models: string[], defaultModel: string): ModelCatalogEntry {
  return { models, defaultModel, source: "static" };
}

function staticCatalogs(): Record<AgentKind, ModelCatalogEntry> {
  return {
    claude: staticEntry(CLAUDE_MODELS, "sonnet"),
    aisdk: staticEntry(AISDK_MODELS, "opus"),
    codex: staticEntry(CODEX_MODELS, "gpt-5.5"),
    "codex-aisdk": staticEntry(CODEX_MODELS, "gpt-5.5"),
    grok: staticEntry(GROK_MODELS, GROK_DEFAULT_MODEL),
    hermes: staticEntry(HERMES_MODELS, HERMES_DEFAULT_MODEL),
    opencode: staticEntry(OPENCODE_MODELS, OPENCODE_DEFAULT_MODEL),
  };
}

export function parseCodexDebugModels(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : [];
  return unique(
    rows
      .map((row) =>
        row && typeof row === "object" && typeof (row as { slug?: unknown }).slug === "string"
          ? {
              slug: (row as { slug: string }).slug.trim(),
              visibility: (row as { visibility?: unknown }).visibility,
            }
          : null,
      )
      .filter((row): row is { slug: string; visibility: unknown } => !!row)
      .filter((row) => row.visibility === "list" && MODEL_NAME_RE.test(row.slug))
      .map((row) => row.slug),
  );
}

export function parseOpencodeModels(stdout: string): string[] {
  return unique(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => OPENCODE_MODEL_RE.test(line))
      .filter((line) => !OPENCODE_DISABLED_MODELS.has(line)),
  );
}

async function runCommand(cmd: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), 2500);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

function commandError(result: CommandResult): string {
  return (result.stderr || result.stdout || `command exited ${result.exitCode}`).trim();
}

export async function buildModelCatalogResponse(
  runner: CommandRunner = runCommand,
): Promise<ModelCatalogResponse> {
  const catalogs = staticCatalogs();

  try {
    const result = await runner(["codex", "debug", "models"]);
    if (result.exitCode !== 0) throw new Error(commandError(result));
    const models = parseCodexDebugModels(result.stdout);
    if (!models.length) throw new Error("codex returned no listable models");
    const entry: ModelCatalogEntry = {
      models,
      defaultModel: models.includes("gpt-5.5") ? "gpt-5.5" : models[0],
      source: "codex-cli",
    };
    catalogs.codex = entry;
    catalogs["codex-aisdk"] = entry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    catalogs.codex = { ...catalogs.codex, error: message };
    catalogs["codex-aisdk"] = { ...catalogs["codex-aisdk"], error: message };
  }

  try {
    const result = await runner(["opencode", "models"]);
    if (result.exitCode !== 0) throw new Error(commandError(result));
    const models = parseOpencodeModels(result.stdout);
    if (!models.length) throw new Error("opencode returned no usable models");
    catalogs.opencode = {
      models,
      defaultModel: models.includes(OPENCODE_DEFAULT_MODEL) ? OPENCODE_DEFAULT_MODEL : models[0],
      source: "opencode-cli",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    catalogs.opencode = { ...catalogs.opencode, error: message };
  }

  return { catalogs };
}
