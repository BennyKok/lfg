# Dynamic Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dynamic model catalogs for LFG model dropdowns, using Codex and OpenCode CLI catalogs when available while preserving static fallbacks.

**Architecture:** Put backend catalog discovery in a focused `src/model-catalog.ts` module that owns static fallback constants, CLI parsing, CLI execution, and response assembly. Put frontend catalog fallback/merge helpers in `web/src/model-catalog.ts`, then have `web/src/App.tsx` fetch `/api/model-catalog` once and read all dropdown options through a React context-backed helper.

**Tech Stack:** Bun, TypeScript, Bun test runner, React/Vite frontend.

---

## File Structure

- Create `src/model-catalog.ts`: backend source of truth for static server model constants, dynamic CLI parsers, and `buildModelCatalogResponse()`.
- Create `src/model-catalog.test.ts`: unit tests for backend parsers and static fallback behavior.
- Modify `src/commands/serve.ts`: import backend constants from `src/model-catalog.ts` and add `GET /api/model-catalog`.
- Create `web/src/model-catalog.ts`: frontend static fallback catalogs plus validated merge/access helpers.
- Create `web/src/model-catalog.test.ts`: unit tests for frontend merge/access helpers.
- Modify `web/src/App.tsx`: remove local model arrays, import frontend catalog helpers, fetch catalogs in `App`, and update model dropdown consumers to use the effective catalog.

## Task 1: Backend Catalog Tests

**Files:**
- Create: `src/model-catalog.test.ts`
- Production file introduced in Task 2: `src/model-catalog.ts`

- [ ] **Step 1: Write the failing backend tests**

Create `src/model-catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  OPENCODE_MODELS,
  buildModelCatalogResponse,
  parseCodexDebugModels,
  parseOpencodeModels,
} from "./model-catalog.ts";

describe("parseCodexDebugModels", () => {
  test("returns visible codex slugs and excludes hidden entries", () => {
    const raw = JSON.stringify({
      models: [
        { slug: "gpt-5.5", visibility: "list" },
        { slug: "codex-auto-review", visibility: "hide" },
        { slug: "gpt-5.4-mini", visibility: "list" },
        { slug: "", visibility: "list" },
      ],
    });

    expect(parseCodexDebugModels(raw)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  test("accepts a top-level array catalog shape", () => {
    const raw = JSON.stringify([
      { slug: "gpt-5.3-codex", visibility: "list" },
      { slug: "internal", visibility: "hide" },
    ]);

    expect(parseCodexDebugModels(raw)).toEqual(["gpt-5.3-codex"]);
  });
});

describe("parseOpencodeModels", () => {
  test("returns provider/model lines, deduped and filtered", () => {
    const stdout = [
      "opencode/big-pickle",
      "anthropic/claude-sonnet-5",
      "not a model",
      "fugu/fugu",
      "anthropic/claude-sonnet-5",
    ].join("\n");

    expect(parseOpencodeModels(stdout)).toEqual([
      "opencode/big-pickle",
      "anthropic/claude-sonnet-5",
    ]);
  });
});

describe("buildModelCatalogResponse", () => {
  test("uses codex and opencode CLI catalogs when commands succeed", async () => {
    const response = await buildModelCatalogResponse(async (cmd) => {
      if (cmd.join(" ") === "codex debug models") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            models: [
              { slug: "gpt-5.5", visibility: "list" },
              { slug: "codex-auto-review", visibility: "hide" },
              { slug: "gpt-5.4", visibility: "list" },
            ],
          }),
          stderr: "",
        };
      }
      if (cmd.join(" ") === "opencode models") {
        return {
          exitCode: 0,
          stdout: "opencode/big-pickle\nopenai/gpt-5.5\n",
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${cmd.join(" ")}`);
    });

    expect(response.catalogs.codex).toEqual({
      models: ["gpt-5.5", "gpt-5.4"],
      defaultModel: "gpt-5.5",
      source: "codex-cli",
    });
    expect(response.catalogs["codex-aisdk"]).toEqual({
      models: ["gpt-5.5", "gpt-5.4"],
      defaultModel: "gpt-5.5",
      source: "codex-cli",
    });
    expect(response.catalogs.opencode).toEqual({
      models: ["opencode/big-pickle", "openai/gpt-5.5"],
      defaultModel: "opencode/big-pickle",
      source: "opencode-cli",
    });
  });

  test("falls back to static catalogs with error messages when commands fail", async () => {
    const response = await buildModelCatalogResponse(async (cmd) => ({
      exitCode: 1,
      stdout: "",
      stderr: `${cmd[0]} failed`,
    }));

    expect(response.catalogs.codex.source).toBe("static");
    expect(response.catalogs.codex.models).toEqual(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(response.catalogs.codex.error).toContain("codex failed");
    expect(response.catalogs.opencode.source).toBe("static");
    expect(response.catalogs.opencode.models).toEqual(OPENCODE_MODELS);
    expect(response.catalogs.opencode.error).toContain("opencode failed");
  });
});
```

- [ ] **Step 2: Run the backend test to verify it fails**

Run:

```bash
bun test src/model-catalog.test.ts
```

Expected: FAIL because `src/model-catalog.ts` does not exist or does not export the tested functions.

## Task 2: Backend Catalog Module

**Files:**
- Create: `src/model-catalog.ts`
- Test: `src/model-catalog.test.ts`

- [ ] **Step 1: Implement the backend catalog module**

Create `src/model-catalog.ts`:

```ts
export type AgentKind = "claude" | "aisdk" | "codex" | "codex-aisdk" | "opencode" | "grok" | "hermes";
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
const OPENCODE_MODEL_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]{1,100}$/;

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
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
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
```

- [ ] **Step 2: Run backend tests to verify they pass**

Run:

```bash
bun test src/model-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit backend catalog module**

Run:

```bash
git add src/model-catalog.ts src/model-catalog.test.ts
git commit -m "feat: add model catalog discovery"
```

## Task 3: Backend Route Wiring

**Files:**
- Modify: `src/commands/serve.ts`
- Test: `src/model-catalog.test.ts`

- [ ] **Step 1: Import catalog constants and builder in `serve.ts`**

Replace the local model constants near the top of `src/commands/serve.ts` with imports from `../model-catalog.ts`.

Add this import with the other local imports:

```ts
import {
  AISDK_MODELS,
  CLAUDE_MODELS,
  GROK_DEFAULT_MODEL,
  GROK_MODELS,
  HERMES_DEFAULT_MODEL,
  HERMES_MODELS,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_DISABLED_MODELS,
  buildModelCatalogResponse,
} from "../model-catalog.ts";
```

Delete the local `CLAUDE_MODELS`, `AISDK_MODELS`, `GROK_MODELS`, `GROK_DEFAULT_MODEL`, `HERMES_MODELS`, `HERMES_DEFAULT_MODEL`, `OPENCODE_DEFAULT_MODEL`, and `OPENCODE_DISABLED_MODELS` declarations from `src/commands/serve.ts`. Leave `HERMES_PROVIDER` in `serve.ts`.

- [ ] **Step 2: Add the `/api/model-catalog` route**

Add this route before the session creation routes in `src/commands/serve.ts`:

```ts
      if (path === "/api/model-catalog" && req.method === "GET") {
        return json(await buildModelCatalogResponse());
      }
```

- [ ] **Step 3: Verify backend route wiring compiles**

Run:

```bash
bunx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Commit backend route wiring**

Run:

```bash
git add src/commands/serve.ts
git commit -m "feat: expose model catalog API"
```

## Task 4: Frontend Catalog Helper Tests

**Files:**
- Create: `web/src/model-catalog.test.ts`
- Production file introduced in Task 5: `web/src/model-catalog.ts`

- [ ] **Step 1: Write failing frontend helper tests**

Create `web/src/model-catalog.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  STATIC_MODEL_CATALOGS,
  defaultModelForAgent,
  mergeModelCatalogs,
  modelsForAgent,
} from "./model-catalog";

describe("mergeModelCatalogs", () => {
  test("uses server catalogs with non-empty models", () => {
    const catalogs = mergeModelCatalogs({
      catalogs: {
        codex: {
          models: ["gpt-5.5", "gpt-5.3-codex"],
          defaultModel: "gpt-5.5",
          source: "codex-cli",
        },
        opencode: {
          models: ["opencode/big-pickle"],
          defaultModel: "opencode/big-pickle",
          source: "opencode-cli",
        },
      },
    });

    expect(catalogs.codex.models).toEqual(["gpt-5.5", "gpt-5.3-codex"]);
    expect(catalogs.opencode.defaultModel).toBe("opencode/big-pickle");
  });

  test("keeps static fallback when server catalog is missing or empty", () => {
    const catalogs = mergeModelCatalogs({
      catalogs: {
        codex: {
          models: [],
          defaultModel: "gpt-5.5",
          source: "codex-cli",
        },
      },
    });

    expect(catalogs.codex).toEqual(STATIC_MODEL_CATALOGS.codex);
    expect(catalogs.claude).toEqual(STATIC_MODEL_CATALOGS.claude);
  });
});

describe("catalog accessors", () => {
  test("return per-agent models and defaults", () => {
    expect(modelsForAgent(STATIC_MODEL_CATALOGS, "aisdk")).toEqual(["opus", "sonnet", "haiku"]);
    expect(defaultModelForAgent(STATIC_MODEL_CATALOGS, "opencode")).toBe("opencode-go/deepseek-v4-flash");
  });
});
```

- [ ] **Step 2: Run the frontend helper test to verify it fails**

Run:

```bash
cd web && bun test src/model-catalog.test.ts
```

Expected: FAIL because `web/src/model-catalog.ts` does not exist.

## Task 5: Frontend Catalog Helper Module

**Files:**
- Create: `web/src/model-catalog.ts`
- Test: `web/src/model-catalog.test.ts`

- [ ] **Step 1: Implement frontend catalog helpers**

Create `web/src/model-catalog.ts`:

```ts
export type AgentKind = "claude" | "aisdk" | "codex" | "codex-aisdk" | "opencode" | "grok" | "hermes";
export type ModelCatalogSource = "static" | "opencode-cli" | "codex-cli" | "hermes-api";

export type ModelCatalogEntry = {
  models: string[];
  defaultModel: string;
  source: ModelCatalogSource;
  error?: string;
};

export type ModelCatalogs = Record<AgentKind, ModelCatalogEntry>;
export type ModelCatalogResponse = { catalogs?: Partial<Record<AgentKind, ModelCatalogEntry>> };

export const STATIC_MODEL_CATALOGS: ModelCatalogs = {
  claude: { models: ["sonnet", "opus", "haiku", "fable"], defaultModel: "sonnet", source: "static" },
  aisdk: { models: ["opus", "sonnet", "haiku"], defaultModel: "opus", source: "static" },
  codex: { models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"], defaultModel: "gpt-5.5", source: "static" },
  "codex-aisdk": { models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"], defaultModel: "gpt-5.5", source: "static" },
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
```

- [ ] **Step 2: Run frontend helper tests to verify they pass**

Run:

```bash
cd web && bun test src/model-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit frontend catalog helpers**

Run:

```bash
git add web/src/model-catalog.ts web/src/model-catalog.test.ts
git commit -m "feat: add frontend model catalog helpers"
```

## Task 6: Frontend App Wiring

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/model-catalog.test.ts`

- [ ] **Step 1: Update React imports**

In `web/src/App.tsx`, add `createContext` and `useContext` to the React import:

```ts
import { Component, createContext, forwardRef, memo, Suspense, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 2: Import catalog helpers**

Add this import near the other local imports:

```ts
import {
  STATIC_MODEL_CATALOGS,
  defaultModelForAgent,
  fallbackModelsForAgent,
  mergeModelCatalogs,
  modelsForAgent,
  type AgentKind,
  type ModelCatalogResponse,
  type ModelCatalogs,
} from "./model-catalog";
```

- [ ] **Step 3: Remove local static model arrays and defaults**

Delete the local `CLAUDE_MODELS`, `CODEX_MODELS`, `AISDK_MODELS`, `CODEX_AISDK_MODELS`, `GROK_MODELS`, `HERMES_MODELS`, `OPENCODE_MODELS`, `AGENT_MODELS`, `AGENT_DEFAULT_MODEL`, and local `type AgentKind` declarations from `web/src/App.tsx`.

Add these helpers where the old constants lived:

```ts
const ModelCatalogContext = createContext<ModelCatalogs>(STATIC_MODEL_CATALOGS);

function useModelCatalogs(): ModelCatalogs {
  return useContext(ModelCatalogContext);
}

function useAgentModels(agent: AgentKind): string[] {
  return modelsForAgent(useModelCatalogs(), agent);
}

function useAgentDefaultModel(agent: AgentKind): string {
  return defaultModelForAgent(useModelCatalogs(), agent);
}
```

- [ ] **Step 4: Fetch model catalogs in `App`**

Inside `App`, add state near the other top-level state:

```ts
  const [modelCatalogs, setModelCatalogs] = useState<ModelCatalogs>(STATIC_MODEL_CATALOGS);
```

Add this effect near the other startup effects:

```ts
  useEffect(() => {
    let cancelled = false;
    api<ModelCatalogResponse>("/api/model-catalog")
      .then((payload) => {
        if (!cancelled) setModelCatalogs(mergeModelCatalogs(payload));
      })
      .catch(() => {
        if (!cancelled) setModelCatalogs(STATIC_MODEL_CATALOGS);
      });
    return () => {
      cancelled = true;
    };
  }, []);
```

Wrap the existing returned app body with the provider:

```tsx
    <ModelCatalogContext.Provider value={modelCatalogs}>
      <AskProvider>
        {/* existing app body */}
      </AskProvider>
    </ModelCatalogContext.Provider>
```

- [ ] **Step 5: Replace direct default/model references in components**

Update each component that currently reads `AGENT_MODELS` or `AGENT_DEFAULT_MODEL`.

For `defaultForkAgent`, replace the saved-agent check:

```ts
  if (saved && STATIC_MODEL_CATALOGS[saved]) return saved;
```

In `ForkSessionDialog`, add:

```ts
  const catalogs = useModelCatalogs();
  const models = modelsForAgent(catalogs, agent);
```

Replace initial default and agent-change defaults with:

```ts
defaultModelForAgent(STATIC_MODEL_CATALOGS, defaultForkAgent(session.agent))
```

and:

```ts
setModel(localStorage.getItem(`lfg_fork_model_${key}`) || defaultModelForAgent(catalogs, key));
```

In `SessionCard`, add:

```ts
  const catalogs = useModelCatalogs();
```

Replace the model switcher list with:

```tsx
                {modelsForAgent(catalogs, session.agent as AgentKind).map((item) => (
```

Use `fallbackModelsForAgent("claude")` only where the existing code needs a literal Claude fallback, such as resume filtering:

```ts
    const claudeModel = fallbackModelsForAgent("claude").includes(model) ? model : undefined;
```

In `NewSessionDialog`, add:

```ts
  const catalogs = useModelCatalogs();
  const models = modelsForAgent(catalogs, agent);
```

Use static defaults for `useState` initializers, then dynamic defaults after catalog fetch:

```ts
defaultModelForAgent(STATIC_MODEL_CATALOGS, (localStorage.getItem("lfg_v2_agent") as AgentKind | null) || "aisdk")
```

and on agent changes:

```ts
setModel(localStorage.getItem(`lfg_model_${next}`) || defaultModelForAgent(catalogs, next));
```

In `AutoAgentModelPicker`, add:

```ts
  const catalogs = useModelCatalogs();
  const models = modelsForAgent(catalogs, backend);
```

In `FindingSheet`, `NewAutoAgentComposer`, and `AgentEditorSheet`, add `const catalogs = useModelCatalogs();` and replace `AGENT_DEFAULT_MODEL[...]` / `AGENT_MODELS[...]` with `defaultModelForAgent(catalogs, ...)` / `modelsForAgent(catalogs, ...)`. For state initializers that run before hooks are available, use `STATIC_MODEL_CATALOGS`.

- [ ] **Step 6: Run frontend tests and typecheck**

Run:

```bash
cd web && bun test src/model-catalog.test.ts
cd web && bun run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit frontend wiring**

Run:

```bash
git add web/src/App.tsx
git commit -m "feat: use dynamic model catalogs in UI"
```

## Task 7: End-to-End Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
bun test src/model-catalog.test.ts
cd web && bun test src/model-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repo typecheck**

Run:

```bash
bunx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run web production build**

Run:

```bash
cd web && bun run build
```

Expected: PASS. The build runs `tsc --noEmit && vite build`.

- [ ] **Step 4: Manually inspect catalog endpoint**

Run the server:

```bash
bun run serve
```

In another shell, run:

```bash
curl -s http://127.0.0.1:8766/api/model-catalog
```

Expected: JSON with `catalogs.codex.source` equal to `codex-cli` when Codex is installed and working, `catalogs.opencode.source` equal to `opencode-cli` when OpenCode is installed and working, otherwise `source: "static"` with an `error` field.

- [ ] **Step 5: Manual UI check**

Run the web dev server if needed:

```bash
cd web && bun run dev
```

Expected: existing model dropdowns render immediately from static fallbacks and update to dynamic Codex/OpenCode catalogs after `/api/model-catalog` resolves. Creating a Codex/OpenCode session still posts the selected model to `/api/sessions/new`.

## Self-Review

- Spec coverage: The plan adds a backend `GET /api/model-catalog`, dynamic Codex discovery through `codex debug models`, dynamic OpenCode discovery through `opencode models`, static fallback catalogs, and frontend dropdown wiring.
- Placeholder scan: No task contains unresolved placeholder language or unspecified test steps.
- Type consistency: Backend and frontend both use `AgentKind`, `ModelCatalogEntry`, and `ModelCatalogResponse`; frontend intentionally has its own browser-local copy to avoid importing server code into Vite.
