import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";

export type CodingAgentKind =
  | "claude"
  | "aisdk"
  | "codex"
  | "codex-aisdk"
  | "opencode"
  | "grok"
  | "cursor"
  | "hermes";

export type CodingAgentSetting = {
  visible: boolean;
};

export type CodingAgentConfig = {
  agents: Partial<Record<CodingAgentKind, CodingAgentSetting>>;
};

export type CodingAgentCheck = {
  label: string;
  ok: boolean;
  detail?: string;
};

export type CodingAgentStatus = {
  configured: boolean;
  checks: CodingAgentCheck[];
  instructions: string[];
  canAutoSetup: boolean;
  canLoginInTerminal: boolean;
  setupRunning: boolean;
  setupProgress?: {
    percent: number;
    label: string;
  };
  installCommand?: string;
  loginCommand?: string;
};

export type CodingAgentInfo = {
  key: CodingAgentKind;
  label: string;
  visible: boolean;
  status: CodingAgentStatus;
};

export type SetupCheck = {
  key: string;
  label: string;
  configured: boolean;
  running: boolean;
  checks: CodingAgentCheck[];
  instructions: string[];
  canAutoSetup: boolean;
  actionLabel: string;
};

export const CODING_AGENT_KINDS: Exclude<CodingAgentKind, "claude" | "hermes">[] = [
  "aisdk",
  "codex-aisdk",
  "grok",
  "cursor",
  "opencode",
];

export const CODING_AGENT_LABELS: Record<CodingAgentKind, string> = {
  claude: "claude",
  aisdk: "claude",
  codex: "codex",
  "codex-aisdk": "codex",
  opencode: "opencode",
  grok: "grok",
  cursor: "cursor",
  hermes: "hermes",
};

const CONFIG_PATH = join(PATHS.data, "coding-agents.json");
const setupRuns = new Map<CodingAgentKind, Promise<void>>();
const setupProgress = new Map<CodingAgentKind, { percent: number; label: string }>();
const systemSetupRuns = new Map<string, Promise<void>>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function getCodingAgentConfig(): Promise<CodingAgentConfig> {
  const raw = readJson<CodingAgentConfig>(CONFIG_PATH);
  return { agents: raw?.agents ?? {} };
}

export async function setCodingAgentVisibility(
  kind: CodingAgentKind,
  visible: boolean,
): Promise<CodingAgentConfig> {
  const cfg = await getCodingAgentConfig();
  cfg.agents[kind] = { ...(cfg.agents[kind] ?? {}), visible };
  await mkdir(PATHS.data, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

function which(name: string, extra: string[] = []): string | null {
  try {
    const onPath = Bun.which(name);
    if (onPath) return onPath;
  } catch {}
  for (const p of extra) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function bunPath(): string | null {
  try {
    return Bun.which("bun") ?? process.execPath ?? null;
  } catch {
    return process.execPath ?? null;
  }
}

function userHome(): string {
  return process.env.HOME ?? homedir();
}

function claudePath(): string | null {
  const home = userHome();
  return which("claude", [
    process.env.LFG_CLAUDE_PATH ?? "",
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    "/usr/local/bin/claude",
  ]);
}

function codexPath(): string | null {
  const home = userHome();
  return which("codex", [
    process.env.LFG_CODEX_PATH ?? "",
    `${home}/.local/bin/codex`,
    `${home}/.bun/bin/codex`,
    "/usr/local/bin/codex",
  ]);
}

function opencodePath(): string | null {
  const home = userHome();
  return which("opencode", [
    process.env.LFG_OPENCODE_PATH ?? "",
    `${home}/.local/bin/opencode`,
    `${home}/.bun/bin/opencode`,
    "/usr/local/bin/opencode",
  ]);
}

function grokPath(): string | null {
  const home = userHome();
  return which("grok", [
    process.env.LFG_GROK_PATH ?? "",
    `${home}/.local/bin/grok`,
    `${home}/.bun/bin/grok`,
    `${home}/.grok/downloads/grok-linux-x86_64`,
    "/usr/local/bin/grok",
  ]);
}

function isGrokAgentPath(path: string): boolean {
  try {
    const real = realpathSync(path);
    return real.includes("/.grok/") || real.endsWith("/grok-linux-x86_64");
  } catch {
    return path.includes("/.grok/");
  }
}

function cursorPath(): string | null {
  const home = userHome();
  const cursorAgent = rejectGrokAgent(which("cursor-agent", [
    process.env.LFG_CURSOR_PATH ?? "",
    `${home}/.local/bin/cursor-agent`,
    `${home}/.bun/bin/cursor-agent`,
    "/usr/local/bin/cursor-agent",
  ]));
  if (cursorAgent) return cursorAgent;
  return rejectGrokAgent(which("agent", [
    `${home}/.local/bin/agent`,
    `${home}/.bun/bin/agent`,
    "/usr/local/bin/agent",
  ]));
}

function rejectGrokAgent(path: string | null): string | null {
  if (!path) return null;
  return isGrokAgentPath(path) ? null : path;
}

function hermesPath(): string | null {
  const home = userHome();
  return which("hermes", [
    process.env.LFG_HERMES_PATH ?? "",
    `${home}/.local/bin/hermes`,
    `${home}/.bun/bin/hermes`,
    "/usr/local/bin/hermes",
  ]);
}

function hasClaudeAuth(): boolean {
  const home = userHome();
  return !!process.env.ANTHROPIC_API_KEY || existsSync(`${home}/.claude/.credentials.json`);
}

function hasCodexAuth(): boolean {
  const home = userHome();
  return (
    !!process.env.OPENAI_API_KEY ||
    existsSync(`${home}/.codex/auth.json`) ||
    !!(codexPath() && commandOutput([codexPath()!, "login", "status"]).ok)
  );
}

function commandOutput(argv: string[]): { ok: boolean; text: string } {
  try {
    const proc = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const text = `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`;
    return { ok: proc.exitCode === 0, text };
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
}

function mcpCommandArgs(): string[] | null {
  const bun = bunPath();
  if (!bun) return null;
  return [bun, join(PATHS.root, "src", "cli.ts"), "mcp"];
}

function hasClaudeLfgMcp(): boolean {
  const claude = claudePath();
  const args = mcpCommandArgs();
  if (!claude || !args) return false;
  const out = commandOutput([claude, "mcp", "get", "lfg"]);
  if (!out.ok) return false;
  return args.every((part) => out.text.includes(part));
}

function hasCodexLfgMcp(): boolean {
  const codex = codexPath();
  const args = mcpCommandArgs();
  if (!codex || !args) return false;
  const out = commandOutput([codex, "mcp", "get", "lfg"]);
  if (!out.ok) return false;
  return args.every((part) => out.text.includes(part));
}

function hasGrokAuth(): boolean {
  const home = userHome();
  return !!process.env.XAI_API_KEY || existsSync(`${home}/.grok`);
}

function hasCursorAuth(): boolean {
  const home = userHome();
  return !!process.env.CURSOR_API_KEY || existsSync(`${home}/.cursor`);
}

function hasHermesConfig(): boolean {
  const home = userHome();
  return !!process.env.LFG_HERMES_PROVIDER || existsSync(`${home}/.hermes`);
}

function installCommandFor(kind: CodingAgentKind): string | null {
  if (kind === "claude" || kind === "aisdk") return "curl -fsSL https://claude.ai/install.sh | bash";
  if (kind === "codex" || kind === "codex-aisdk") return "bun add -g @openai/codex";
  if (kind === "opencode") return "bun add -g opencode-ai";
  if (kind === "grok") return "curl -fsSL https://x.ai/cli/install.sh | bash";
  if (kind === "cursor") return "curl -fsSL https://cursor.com/install | bash";
  if (kind === "hermes") return "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
  return null;
}

function loginCommandPartsFor(kind: CodingAgentKind): string[] | null {
  if (kind === "claude" || kind === "aisdk") {
    return [claudePath() ?? "claude", "auth", "login", "--claudeai"];
  }
  if (kind === "codex" || kind === "codex-aisdk") {
    return [codexPath() ?? "codex", "login", "--device-auth"];
  }
  if (kind === "opencode") return [opencodePath() ?? "opencode"];
  if (kind === "grok") return [grokPath() ?? "grok"];
  if (kind === "cursor") return [cursorPath() ?? "cursor-agent", "login"];
  if (kind === "hermes") return [hermesPath() ?? "hermes"];
  return null;
}

export function loginCommandFor(kind: CodingAgentKind): string | null {
  const parts = loginCommandPartsFor(kind);
  return parts ? parts.map(shellQuote).join(" ") : null;
}

function statusFor(kind: CodingAgentKind): CodingAgentStatus {
  const checks: CodingAgentCheck[] = [];
  const instructions: string[] = [];
  let canAutoSetup = true;
  let canLoginInTerminal = true;

  const addBinary = (label: string, path: string | null) => {
    checks.push({ label, ok: !!path, detail: path ?? "not found" });
  };
  const addAuth = (label: string, ok: boolean, detail: string) => {
    checks.push({ label, ok, detail });
  };

  if (kind === "claude" || kind === "aisdk") {
    addBinary("Claude CLI", claudePath());
    addAuth("Claude auth", hasClaudeAuth(), "run `claude` once or set ANTHROPIC_API_KEY");
    instructions.push("Run `claude` once and finish the browser sign-in, or set ANTHROPIC_API_KEY.");
  } else if (kind === "codex" || kind === "codex-aisdk") {
    addBinary("Codex CLI", codexPath());
    addAuth("Codex auth", hasCodexAuth(), "run `codex` once or set OPENAI_API_KEY");
    instructions.push("Run `codex` once and sign in, or set OPENAI_API_KEY.");
  } else if (kind === "opencode") {
    addBinary("OpenCode CLI", opencodePath());
    instructions.push("Install/authenticate OpenCode, then verify `opencode` works from this user.");
  } else if (kind === "cursor") {
    addBinary("Cursor CLI", cursorPath());
    addAuth("Cursor auth", hasCursorAuth(), "run `cursor-agent login` once or set CURSOR_API_KEY");
    instructions.push("Install Cursor CLI, then run `cursor-agent login` and sign in, or set CURSOR_API_KEY.");
  } else if (kind === "hermes") {
    addBinary("Hermes CLI", hermesPath());
    addAuth("Hermes config", hasHermesConfig(), "set LFG_HERMES_PROVIDER if your install needs it");
    instructions.push("Install Hermes and set LFG_HERMES_PROVIDER when your provider is not the default.");
  } else {
    addBinary("Grok CLI", grokPath());
    addAuth("Grok auth", hasGrokAuth(), "run `grok` once or set XAI_API_KEY");
    instructions.push("Install Grok, then run `grok` once and sign in, or set XAI_API_KEY.");
  }

  return {
    configured: checks.every((c) => c.ok),
    checks,
    instructions,
    canAutoSetup,
    canLoginInTerminal,
    setupRunning: setupRuns.has(kind),
    setupProgress: setupProgress.get(kind),
    installCommand: installCommandFor(kind) ?? undefined,
    loginCommand: loginCommandFor(kind) ?? undefined,
  };
}

export async function listCodingAgents(): Promise<CodingAgentInfo[]> {
  const cfg = await getCodingAgentConfig();
  return CODING_AGENT_KINDS.map((key) => ({
    key,
    label: CODING_AGENT_LABELS[key],
    visible: cfg.agents[key]?.visible !== false,
    status: statusFor(key),
  }));
}

export async function listSetupChecks(): Promise<SetupCheck[]> {
  const args = mcpCommandArgs();
  const claude = claudePath();
  const codex = codexPath();
  const checks: CodingAgentCheck[] = [
    { label: "Bun", ok: !!bunPath(), detail: bunPath() ?? "not found" },
    { label: "tmux", ok: !!which("tmux"), detail: which("tmux") ?? "not found" },
    { label: "git", ok: !!which("git"), detail: which("git") ?? "not found" },
    { label: "LFG MCP command", ok: !!args, detail: args?.join(" ") ?? "not available" },
  ];
  if (claude) {
    checks.push({
      label: "Claude MCP",
      ok: hasClaudeLfgMcp(),
      detail: hasClaudeLfgMcp() ? "registered" : "not registered",
    });
  } else {
    checks.push({ label: "Claude MCP", ok: true, detail: "Claude CLI not installed" });
  }
  if (codex) {
    checks.push({
      label: "Codex MCP",
      ok: hasCodexLfgMcp(),
      detail: hasCodexLfgMcp() ? "registered" : "not registered",
    });
  } else {
    checks.push({ label: "Codex MCP", ok: true, detail: "Codex CLI not installed" });
  }
  return [
    {
      key: "lfg-mcp",
      label: "LFG MCP",
      configured: checks.every((check) => check.ok),
      running: systemSetupRuns.has("lfg-mcp"),
      checks,
      instructions: [
        "Registers the local LFG MCP server with Claude and Codex when those CLIs are installed.",
      ],
      canAutoSetup: !!args && (!!claude || !!codex),
      actionLabel: "Install MCP",
    },
  ];
}

function installClaudeMcp(claude: string, args: string[]): void {
  commandOutput([claude, "mcp", "remove", "lfg", "-s", "user"]);
  const out = commandOutput([claude, "mcp", "add", "-s", "user", "lfg", "--", ...args]);
  if (!out.ok) throw new Error(out.text.trim() || "Claude MCP install failed");
}

function installCodexMcp(codex: string, args: string[]): void {
  commandOutput([codex, "mcp", "remove", "lfg"]);
  const out = commandOutput([codex, "mcp", "add", "lfg", "--", ...args]);
  if (!out.ok) throw new Error(out.text.trim() || "Codex MCP install failed");
}

export async function runSetupAction(key: string): Promise<void> {
  if (key !== "lfg-mcp") throw new Error(`unknown setup action "${key}"`);
  if (systemSetupRuns.has(key)) throw new Error(`${key} setup is already running`);
  const run = (async () => {
    const args = mcpCommandArgs();
    if (!args) throw new Error("Bun is required to register the LFG MCP server");
    const claude = claudePath();
    const codex = codexPath();
    if (!claude && !codex) throw new Error("Install Claude or Codex first, then register the LFG MCP server");
    if (claude) installClaudeMcp(claude, args);
    if (codex) installCodexMcp(codex, args);
  })();
  systemSetupRuns.set(key, run);
  try {
    await run;
  } finally {
    systemSetupRuns.delete(key);
  }
}

function setupEnvFor(kind: CodingAgentKind): Record<string, string> | null {
  if (kind === "claude" || kind === "aisdk") return { LFG_INSTALL_CLAUDE: "1" };
  if (kind === "codex" || kind === "codex-aisdk") return { LFG_INSTALL_CODEX: "1" };
  if (kind === "opencode") return { LFG_INSTALL_OPENCODE: "1" };
  if (kind === "grok") return { LFG_INSTALL_GROK: "1" };
  if (kind === "cursor") return { LFG_INSTALL_CURSOR: "1" };
  if (kind === "hermes") return { LFG_INSTALL_HERMES: "1" };
  return null;
}

export async function runCodingAgentSetups(kinds: CodingAgentKind[]): Promise<void> {
  const uniqueKinds = [...new Set(kinds)];
  if (!uniqueKinds.length) throw new Error("select at least one coding agent");
  const runningKind = uniqueKinds.find((kind) => setupRuns.has(kind));
  if (runningKind) throw new Error(`${runningKind} setup is already running`);

  const setupEnv: Record<string, string> = {};
  for (const kind of uniqueKinds) {
    const env = setupEnvFor(kind);
    if (!env) throw new Error(`${kind} does not have an automatic setup path`);
    Object.assign(setupEnv, env);
    setupProgress.set(kind, { percent: 10, label: "Starting…" });
  }

  const script = join(PATHS.root, "scripts", "setup.sh");
  const run = (async () => {
    const proc = Bun.spawn(["bash", script], {
      cwd: PATHS.root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...setupEnv },
    });
    const stdout = (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let installSeen = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const message = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^==>\s*/, "").trim();
          if (!message) continue;
          if (/Installing .*CLI|Installing OpenCode/i.test(message)) {
            installSeen = true;
            for (const kind of uniqueKinds) {
              setupProgress.set(kind, { percent: 55, label: message });
            }
          } else if (installSeen) {
            for (const kind of uniqueKinds) {
              setupProgress.set(kind, { percent: 80, label: message });
            }
          }
        }
      }
    })();
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
      stdout,
    ]);
    if (code !== 0) {
      throw new Error(stderr.trim().slice(0, 1000) || `setup exited ${code}`);
    }
    for (const kind of uniqueKinds) {
      setupProgress.set(kind, { percent: 95, label: "Verifying installation…" });
    }
  })();
  for (const kind of uniqueKinds) setupRuns.set(kind, run);
  try {
    await run;
  } finally {
    for (const kind of uniqueKinds) {
      if (setupRuns.get(kind) === run) setupRuns.delete(kind);
      setupProgress.delete(kind);
    }
  }
}

export async function runCodingAgentSetup(kind: CodingAgentKind): Promise<void> {
  return runCodingAgentSetups([kind]);
}

export function isCodingAgentKind(value: string): value is CodingAgentKind {
  return (CODING_AGENT_KINDS as string[]).includes(value);
}
