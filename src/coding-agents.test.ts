import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanAuthOutput, listCodingAgents, parseAuthOutput } from "./coding-agents.ts";

const COPILOT_ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

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

describe("copilot auth detection", () => {
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
});
