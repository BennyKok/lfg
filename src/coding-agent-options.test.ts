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

  test("offers only anonymous OpenCode on a hosted box without account auth", () => {
    expect(configuredAgentOptions(options, [
      { key: "aisdk", visible: true, status: { configured: true, accountConnected: false } },
      { key: "codex-aisdk", visible: true, status: { configured: true, accountConnected: false } },
      { key: "opencode", visible: true, status: { configured: true, accountConnected: false } },
    ], "connected-or-opencode")).toEqual([{ key: "opencode", label: "opencode" }]);
  });

  test("adds hosted agents only after their user-owned account is connected", () => {
    expect(configuredAgentOptions(options, [
      { key: "aisdk", visible: true, status: { configured: true, accountConnected: true } },
      { key: "codex-aisdk", visible: true, status: { configured: true, accountConnected: false } },
      { key: "opencode", visible: true, status: { configured: true, accountConnected: false } },
    ], "connected-or-opencode")).toEqual([
      { key: "aisdk", label: "claude" },
      { key: "opencode", label: "opencode" },
    ]);
  });

  test("does not flash account-backed agents while hosted availability loads", () => {
    expect(configuredAgentOptions(options, undefined, "connected-or-opencode")).toEqual([
      { key: "opencode", label: "opencode" },
    ]);
  });
});
