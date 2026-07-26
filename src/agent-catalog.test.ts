import { describe, expect, test } from "bun:test";
import { curateOpenCodeModels } from "./agent-catalog.ts";

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

  test("falls back to family curation when no openai models are discovered", () => {
    expect(curateOpenCodeModels(["opencode-go/kimi-k3", "openrouter/whatever"])).toEqual([
      "opencode-go/kimi-k3",
    ]);
  });
});
