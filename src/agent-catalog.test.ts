import { describe, expect, test } from "bun:test";
import { curateOpenCodeModels, listModelCatalog } from "./agent-catalog.ts";

const DISCOVERED = [
  "openai/gpt-5.3-codex-spark",
  "openai/gpt-5.4",
  "openai/gpt-5.4-fast",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.5",
  "openai/gpt-5.5-fast",
  "openai/gpt-5.6",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-fast",
  "opencode/deepseek-v4-flash-free",
  "opencode/future-coder-free",
  "opencode-go/kimi-k3",
  "opencode-go/kimi-k2.7-code",
  "sakana/fugu",
];

describe("curateOpenCodeModels", () => {
  test("surfaces ChatGPT/Codex models ahead of the go catalog", () => {
    const out = curateOpenCodeModels(DISCOVERED);
    expect(out.slice(0, 4)).toEqual([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.5",
    ]);
    expect(out).toContain("openai/gpt-5.4-mini");
    expect(out).toContain("openai/gpt-5.3-codex-spark");
  });

  test("adds the newest plain flagship without fast/pro variants", () => {
    const out = curateOpenCodeModels(DISCOVERED);
    expect(out).toContain("openai/gpt-5.6");
    expect(out).not.toContain("openai/gpt-5.6-sol-pro");
    expect(out).not.toContain("openai/gpt-5.5-fast");
  });

  test("keeps the existing go families after the openai block", () => {
    const out = curateOpenCodeModels(DISCOVERED);
    expect(out.indexOf("openai/gpt-5.6-sol")).toBeLessThan(out.indexOf("opencode-go/kimi-k3"));
    expect(out).toContain("sakana/fugu");
  });

  test("retains every dynamic credential-free OpenCode model", () => {
    const out = curateOpenCodeModels(DISCOVERED);
    expect(out).toContain("opencode/deepseek-v4-flash-free");
    expect(out).toContain("opencode/future-coder-free");
  });

  test("falls back to family curation when no openai models are discovered", () => {
    expect(curateOpenCodeModels(["opencode-go/kimi-k3", "openrouter/whatever"])).toEqual([
      "opencode-go/kimi-k3",
    ]);
  });
});

function codingAgent(
  key: "claude" | "aisdk" | "codex" | "codex-aisdk" | "opencode",
  accountConnected: boolean,
) {
  return {
    key,
    label: key,
    visible: true,
    status: {
      configured: true,
      accountConnected,
      lfgCapabilityAccess: "mcp" as const,
      checks: [],
      instructions: [],
      canAutoSetup: false,
      canLoginInTerminal: false,
      setupRunning: false,
    },
  };
}

describe("OpenCode catalog default", () => {
  test("selects a live free model when no user-owned account is connected", () => {
    const opencode = listModelCatalog([codingAgent("opencode", false)]).find(
      (item) => item.key === "opencode",
    );
    expect(opencode?.defaultModel).toMatch(/^opencode\/.+-free$/);
    expect(opencode?.models).toContain(opencode?.defaultModel);
  });

  test.each(["claude", "aisdk", "codex", "codex-aisdk"] as const)(
    "keeps the authenticated default for a connected %s account",
    (key) => {
      const opencode = listModelCatalog([codingAgent(key, true)]).find(
        (item) => item.key === "opencode",
      );
      expect(opencode?.defaultModel).toBe("opencode-go/deepseek-v4-flash");
    },
  );

  test("does not treat OpenCode's installed runtime as a user-owned account", () => {
    const opencode = listModelCatalog([codingAgent("opencode", true)]).find(
      (item) => item.key === "opencode",
    );
    expect(opencode?.defaultModel).toMatch(/^opencode\/.+-free$/);
  });
});
