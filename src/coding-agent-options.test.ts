import { describe, expect, test } from "bun:test";
import { configuredAgentOptions } from "../web/src/lib/coding-agent-options.ts";

const options = [
  { key: "aisdk", label: "claude" },
  { key: "codex-aisdk", label: "codex" },
  { key: "opencode", label: "opencode" },
];

describe("configuredAgentOptions", () => {
  test("keeps only visible, fully configured agents", () => {
    expect(configuredAgentOptions(options, [
      { key: "aisdk", visible: true, status: { configured: true } },
      { key: "codex-aisdk", visible: true, status: { configured: false } },
      { key: "opencode", visible: false, status: { configured: true } },
    ])).toEqual([{ key: "aisdk", label: "claude" }]);
  });

  test("does not fall back to unavailable agents", () => {
    expect(configuredAgentOptions(options, [
      { key: "aisdk", visible: true, status: { configured: false } },
    ])).toEqual([]);
  });

  test("preserves options only while availability data is loading", () => {
    expect(configuredAgentOptions(options)).toEqual(options);
  });
});
