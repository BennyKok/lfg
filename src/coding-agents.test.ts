import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanAuthOutput,
  listCodingAgents,
  parseAuthOutput,
  withCursorLfgMcp,
  withOpencodeLfgMcp,
} from "./coding-agents.ts";

const COPILOT_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

describe("LFG MCP config merging", () => {
  const command = ["/usr/bin/bun", "/opt/lfg/src/cli.ts", "mcp"];

  test("preserves OpenCode config while adding the local LFG server", () => {
    expect(withOpencodeLfgMcp({ theme: "dark", mcp: { other: { enabled: true } } }, command)).toEqual({
      theme: "dark",
      mcp: {
        other: { enabled: true },
        lfg: { type: "local", command, enabled: true },
      },
    });
  });

  test("preserves Cursor config while adding the LFG server", () => {
    expect(withCursorLfgMcp({ editor: {}, mcpServers: { other: { command: "other" } } }, command)).toEqual({
      editor: {},
      mcpServers: {
        other: { command: "other" },
        lfg: { command: "/usr/bin/bun", args: ["/opt/lfg/src/cli.ts", "mcp"] },
      },
    });
  });
});

async function copilotAuthOk(): Promise<boolean> {
  const agents = await listCodingAgents();
  const copilot = agents.find((a) => a.key === "copilot");
  if (!copilot) throw new Error("copilot agent not registered");
  const auth = copilot.status.checks.find((c) => c.label === "Copilot auth");
  if (!auth) throw new Error("Copilot auth check missing");
  return auth.ok;
}

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

  test("extracts the Grok device URL and code", () => {
    // Verbatim `grok login --device-auth` output (grok 0.2.114). The code shows
    // up twice — inside the URL and again on its own line.
    const output = [
      "To sign in, open this URL in your browser:",
      "",
      "  https://accounts.x.ai/oauth2/device?user_code=M4EY-Q586",
      "",
      "  (Could not open browser automatically — open the URL above manually.)",
      "",
      "Confirm this code in your browser:",
      "",
      "  M4EY-Q586",
      "",
      "\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m",
      "",
      "Waiting for authorization...",
    ].join("\r\n");

    expect(parseAuthOutput("grok", output)).toEqual({
      authorizationUrl: "https://accounts.x.ai/oauth2/device?user_code=M4EY-Q586",
      userCode: "M4EY-Q586",
      needsCode: false,
    });
  });

  test("reads the Grok code from the prose when the URL carries no query", () => {
    // Guards the fallback branch: if xAI ever drops user_code from the URL, the
    // "Confirm this code" line still has to yield the code, otherwise the login
    // dialog would render a URL with nothing to type.
    const output = [
      "To sign in, open this URL in your browser:",
      "  https://accounts.x.ai/oauth2/device",
      "Confirm this code in your browser:",
      "  ABCD-1234",
    ].join("\n");

    expect(parseAuthOutput("grok", output)).toEqual({
      authorizationUrl: "https://accounts.x.ai/oauth2/device",
      userCode: "ABCD-1234",
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

describe("coding agent auth detection", () => {
  // Isolate the home + env this suite touches so we neither trip on the
  // maintainer's real login state nor leak into other suites.
  const savedEnv: Record<string, string | undefined> = {};
  let tmpHome = "";

  const setEnv = (key: string, value: string | undefined) => {
    savedEnv[key] ??= process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const useTmpHome = () => {
    tmpHome = mkdtempSync(join(tmpdir(), "lfg-copilot-auth-"));
    setEnv("HOME", tmpHome);
    for (const key of COPILOT_ENV_KEYS) setEnv(key, undefined);
    return tmpHome;
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(savedEnv)) delete savedEnv[key];
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = "";
    }
  });

  test("COPILOT_GITHUB_TOKEN alone is sufficient", async () => {
    useTmpHome();
    setEnv("COPILOT_GITHUB_TOKEN", "ghp_test");
    expect(await copilotAuthOk()).toBe(true);
  });

  test("an empty ~/.copilot/ directory is NOT proof of auth", async () => {
    const home = useTmpHome();
    // A stray tool can create the bare dir - it must not count as a login.
    mkdirSync(join(home, ".copilot"), { recursive: true });
    expect(await copilotAuthOk()).toBe(false);
  });

  test("~/.copilot/hosts.yml counts as authenticated", async () => {
    const home = useTmpHome();
    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(join(home, ".copilot", "hosts.yml"), "github.com: {}\n");
    expect(await copilotAuthOk()).toBe(true);
  });

  test("a platform OpenAI key makes Codex runnable without claiming the account is connected", async () => {
    const home = useTmpHome();
    const codex = join(home, "codex");
    writeFileSync(codex, "#!/bin/sh\nexit 1\n");
    chmodSync(codex, 0o755);
    setEnv("LFG_CODEX_PATH", codex);
    setEnv("OPENAI_API_KEY", "platform_test_key");

    const agents = await listCodingAgents();
    const codexAgent = agents.find((agent) => agent.key === "codex-aisdk");
    expect(codexAgent?.status.configured).toBe(true);
    expect(codexAgent?.status.accountConnected).toBe(false);
  });
});
