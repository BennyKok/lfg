import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeConfigDirs,
  cleanAuthOutput,
  getCodingAgentAuth,
  listCodingAgents,
  parseAuthOutput,
  startToolAuth,
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

describe("Claude MCP config dirs", () => {
  const dirs = (id: string) => `/data/claude-accounts/${id}`;

  test("covers every extra account's config dir, not just the default", () => {
    // A registration written only to the default dir leaves sessions bound to
    // account two and three with no LFG tool surface at all.
    expect(claudeConfigDirs([{ id: "default" }, { id: "two" }, { id: "three" }], dirs)).toEqual([
      null,
      "/data/claude-accounts/two",
      "/data/claude-accounts/three",
    ]);
  });

  test("is just the default when no extra accounts exist", () => {
    expect(claudeConfigDirs([{ id: "default" }], dirs)).toEqual([null]);
  });

  test("skips accounts whose config dir cannot be resolved", () => {
    expect(claudeConfigDirs([{ id: "gone" }], () => null)).toEqual([null]);
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

  test("extracts the GitHub verification URL and device code", () => {
    const output = [
      "! First copy your one-time code: 8A2B-C3D4",
      "Press Enter to open https://github.com/login/device in your browser...",
    ].join("\n");

    expect(parseAuthOutput("github", output)).toEqual({
      authorizationUrl: "https://github.com/login/device",
      userCode: "8A2B-C3D4",
      needsCode: false,
    });
  });

  test("advances GitHub's hidden Enter prompt after surfacing the device code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lfg-github-auth-"));
    const binary = join(dir, "gh");
    const marker = join(dir, "advanced");
    const previousGithubPath = process.env.LFG_GH_PATH;
    const previousMarker = process.env.LFG_GITHUB_AUTH_MARKER;
    writeFileSync(
      binary,
      [
        "#!/bin/sh",
        'printf "%s\\n" "! First copy your one-time code: 8A2B-C3D4" >&2',
        'printf "%s\\n" "Press Enter to open https://github.com/login/device in your browser..." >&2',
        "IFS= read -r _",
        'printf "advanced" > "$LFG_GITHUB_AUTH_MARKER"',
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    process.env.LFG_GH_PATH = binary;
    process.env.LFG_GITHUB_AUTH_MARKER = marker;
    try {
      const session = await startToolAuth("github");
      for (let attempt = 0; attempt < 20 && !existsSync(marker); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);
      for (
        let attempt = 0;
        attempt < 20 && getCodingAgentAuth(session.id)?.status !== "complete";
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      expect(getCodingAgentAuth(session.id)?.status).toBe("complete");
    } finally {
      if (previousGithubPath === undefined) delete process.env.LFG_GH_PATH;
      else process.env.LFG_GH_PATH = previousGithubPath;
      if (previousMarker === undefined) delete process.env.LFG_GITHUB_AUTH_MARKER;
      else process.env.LFG_GITHUB_AUTH_MARKER = previousMarker;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extracts the Grok verification URL and device code", () => {
    // Verbatim shape of `grok login --device-auth` (it writes to stderr).
    const output = [
      "",
      "To sign in, open this URL in your browser:",
      "",
      "  https://accounts.x.ai/oauth2/device?user_code=4ZCY-6ZPQ",
      "",
      "Confirm this code in your browser:",
      "",
      "  4ZCY-6ZPQ",
      "",
      "\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m",
      "",
      "Waiting for authorization...",
    ].join("\r\n");

    expect(parseAuthOutput("grok", output)).toEqual({
      authorizationUrl: "https://accounts.x.ai/oauth2/device?user_code=4ZCY-6ZPQ",
      userCode: "4ZCY-6ZPQ",
      needsCode: false,
    });
  });

  test("reads the Grok code from the printed confirmation when the URL omits it", () => {
    const output = [
      "To sign in, open this URL in your browser:",
      "  https://accounts.x.ai/oauth2/device",
      "Confirm this code in your browser:",
      "  4ZCY-6ZPQ",
    ].join("\n");

    expect(parseAuthOutput("grok", output)).toEqual({
      authorizationUrl: "https://accounts.x.ai/oauth2/device",
      userCode: "4ZCY-6ZPQ",
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

  const grokStatus = async (home: string) => {
    const grok = join(home, "grok");
    writeFileSync(grok, "#!/bin/sh\nexit 0\n");
    chmodSync(grok, 0o755);
    setEnv("LFG_GROK_PATH", grok);
    const agents = await listCodingAgents();
    const agent = agents.find((a) => a.key === "grok");
    if (!agent) throw new Error("grok agent not registered");
    return agent.status;
  };

  const useGrokHome = () => {
    const home = useTmpHome();
    setEnv("XAI_API_KEY", undefined);
    return home;
  };

  test("an empty ~/.grok/ directory is NOT proof of a Grok login", async () => {
    const home = useGrokHome();
    // Any `grok` invocation creates ~/.grok — only a saved token is a login.
    mkdirSync(join(home, ".grok"), { recursive: true });
    const status = await grokStatus(home);
    expect(status.accountConnected).toBe(false);
    expect(status.configured).toBe(false);
  });

  test("a saved Grok OIDC token counts as a connected account", async () => {
    const home = useGrokHome();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(
      join(home, ".grok", "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
          key: "xai-access-token",
          refresh_token: "xai-refresh-token",
        },
      }),
    );
    const status = await grokStatus(home);
    expect(status.accountConnected).toBe(true);
    expect(status.configured).toBe(true);
  });

  test("an auth.json with no token is not a Grok login", async () => {
    const home = useGrokHome();
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify({ "https://auth.x.ai::x": {} }));
    expect((await grokStatus(home)).accountConnected).toBe(false);
  });

  test("a platform XAI key makes Grok runnable without claiming the account is connected", async () => {
    const home = useGrokHome();
    setEnv("XAI_API_KEY", "platform_test_key");
    const status = await grokStatus(home);
    expect(status.configured).toBe(true);
    expect(status.accountConnected).toBe(false);
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
