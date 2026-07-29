import { describe, expect, test } from "bun:test";
import {
  CLAUDE_PLATFORM_ENV_KEYS,
  claudeAccountEnv,
} from "./claude-creds.ts";

describe("claudeAccountEnv", () => {
  test("keeps platform auth untouched when no Claude account is connected", () => {
    const source = {
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "platform",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    };
    expect(claudeAccountEnv(source, false)).toBeUndefined();
    expect(source.ANTHROPIC_API_KEY).toBe("platform");
  });

  test("removes every competing Anthropic source and preserves unrelated env", () => {
    const source = {
      HOME: "/home/user",
      PATH: "/usr/bin",
      LFG_SESSION_ID: "session-1",
      ANTHROPIC_API_KEY: "platform",
      ANTHROPIC_AUTH_TOKEN: "platform-token",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    };

    const env = claudeAccountEnv(source, true);

    expect(env).toEqual({
      HOME: "/home/user",
      PATH: "/usr/bin",
      LFG_SESSION_ID: "session-1",
    });
    for (const key of CLAUDE_PLATFORM_ENV_KEYS) {
      expect(env).not.toHaveProperty(key);
    }
    expect(source.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
  });
});
