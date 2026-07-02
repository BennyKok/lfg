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
    const tooLong = `provider/${"x".repeat(80)}`;
    const stdout = [
      "opencode/big-pickle",
      "anthropic/claude-sonnet-5",
      "not a model",
      "fugu/fugu",
      tooLong,
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
