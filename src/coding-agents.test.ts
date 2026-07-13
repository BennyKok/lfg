import { describe, expect, test } from "bun:test";
import { cleanAuthOutput, parseAuthOutput } from "./coding-agents.ts";

describe("coding agent browser auth output", () => {
  test("extracts the Codex verification URL and device code", () => {
    const output = [
      "Follow these steps to sign in with ChatGPT using device code authorization:",
      "1. Open this link in your browser",
      "\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m",
      "2. Enter this one-time code (expires in 15 minutes)",
      "\x1b[94m42DX-1KQLE\x1b[0m",
    ].join("\r\n");

    expect(parseAuthOutput("codex", output)).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      userCode: "42DX-1KQLE",
      needsCode: false,
    });
  });

  test("extracts Claude's OSC hyperlink and detects its code prompt", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    const output = `Opening browser…\r\nIf it didn't open: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\r\nPaste code here if prompted > `;

    expect(parseAuthOutput("claude", output)).toEqual({
      authorizationUrl: url,
      needsCode: true,
    });
    expect(cleanAuthOutput(output)).not.toContain("\x1b");
  });
});
