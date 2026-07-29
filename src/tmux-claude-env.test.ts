import { describe, expect, test } from "bun:test";
import { claudeAccountLaunchCommand } from "./tmux.ts";

describe("Claude account launch environment", () => {
  test("keeps the platform provider environment when no account is connected", () => {
    const command = ["/home/user/.bun/bin/claude", "--model", "sonnet"];

    expect(claudeAccountLaunchCommand(command, false)).toBe(command);
  });

  test("removes every competing Anthropic source for a connected account", () => {
    const command = ["/home/user/.bun/bin/claude", "--model", "sonnet"];
    const argv = claudeAccountLaunchCommand(command, true);

    expect(argv[0]).toMatch(/\/env$/);
    expect(argv.slice(1)).toEqual([
      "-u",
      "ANTHROPIC_API_KEY",
      "-u",
      "ANTHROPIC_AUTH_TOKEN",
      "-u",
      "ANTHROPIC_BASE_URL",
      ...command,
    ]);
  });
});
