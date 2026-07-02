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
