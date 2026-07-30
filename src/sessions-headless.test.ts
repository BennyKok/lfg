import { describe, expect, test } from "bun:test";
import { isHeadlessClaudeArgv } from "./sessions.ts";

describe("Claude process mode detection", () => {
  test("detects real print-mode flags", () => {
    expect(isHeadlessClaudeArgv(["claude", "-p", "summarize this"])).toBe(true);
    expect(isHeadlessClaudeArgv(["claude", "--print", "summarize this"])).toBe(true);
  });

  test("ignores print-like flags inside a managed task prompt", () => {
    expect(
      isHeadlessClaudeArgv([
        "claude",
        "--model",
        "sonnet",
        "--",
        "Verify with tsc -p apps/landing/tsconfig.json --noEmit",
      ]),
    ).toBe(false);
    expect(
      isHeadlessClaudeArgv([
        "claude",
        "--",
        "Explain why `claude --print` behaves differently",
      ]),
    ).toBe(false);
  });
});
