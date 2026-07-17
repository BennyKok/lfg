import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "./config.ts";
import { lfgCapabilityAccess } from "./lfg-capabilities.ts";

export type CodingAgentKind =
  | "claude"
  | "aisdk"
  | "codex"
  | "codex-aisdk"
  | "opencode"
  | "grok"
  | "cursor"
  | "hermes"
  | "copilot";

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
  lfgCapabilityAccess: "mcp" | "contract-only";
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

export type CodingAgentAuthSession = {
  id: string;
  kind: CodingAgentKind;
  provider: "claude" | "codex";
  status: "starting" | "waiting" | "complete" | "error";
  authorizationUrl?: string;
  userCode?: string;
  needsCode: boolean;
  error?: string;
};

type InternalAuthSession = CodingAgentAuthSession & {
  process: ReturnType<typeof Bun.spawn>;
  output: string;
  ready: Promise<void>;
  markReady: () => void;
  expiresAt: number;
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
  "copilot",
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
  copilot: "copilot",
};

const CONFIG_PATH = join(PATHS.data, "coding-agents.json");
const setupRuns = new Map<CodingAgentKind, Promise<void>>();
const setupProgress = new Map<CodingAgentKind, { percent: number; label: string }>();

export type CodingAgentSetupLog = {
  running: boolean;
  kinds: CodingAgentKind[];
  lines: string[];
  error: string | null;
  finishedAt: number | null;
};
const SETUP_LOG_LINE_LIMIT = 600;
let setupLog: CodingAgentSetupLog = {
  running: false,
  kinds: [],
  lines: [],
  error: null,
  finishedAt: null,
};

export function getCodingAgentSetupLog(): CodingAgentSetupLog {
  return { ...setupLog, kinds: [...setupLog.kinds], lines: [...setupLog.lines] };
}

function appendSetupLog(line: string): void {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trimEnd();
  if (!clean.trim()) return;
  setupLog.lines.push(clean);
  if (setupLog.lines.length > SETUP_LOG_LINE_LIMIT) {
    setupLog.lines.splice(0, setupLog.lines.length - SETUP_LOG_LINE_LIMIT);
  }
}
const systemSetupRuns = new Map<string, Promise<void>>();
const authSessions = new Map<string, InternalAuthSession>();
const AUTH_SESSION_TTL_MS = 15 * 60 * 1000;
const AUTH_OUTPUT_LIMIT = 32_000;

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

function copilotPath(): string | null {
  const home = userHome();
  return which("copilot", [
    process.env.LFG_COPILOT_PATH ?? "",
    `${home}/.local/bin/copilot`,
    `${home}/.bun/bin/copilot`,
    "/usr/local/bin/copilot",
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

function commandHasLfgMcp(binary: string | null): boolean {
  if (!binary) return false;
  const out = commandOutput([binary, "mcp", "list"]);
  return out.ok && /\blfg\b/i.test(out.text);
}

function hasOpencodeLfgMcp(): boolean {
  return commandHasLfgMcp(opencodePath());
}

function hasGrokLfgMcp(): boolean {
  return commandHasLfgMcp(grokPath());
}

function hasCursorLfgMcp(): boolean {
  return commandHasLfgMcp(cursorPath());
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

function hasCopilotAuth(): boolean {
  const home = userHome();
  // Precedence matches Copilot CLI's env resolution: a Copilot-specific token
  // wins over generic GH_TOKEN/GITHUB_TOKEN when both are set.
  if (process.env.COPILOT_GITHUB_TOKEN) return true;
  if (process.env.GH_TOKEN) return true;
  if (process.env.GITHUB_TOKEN) return true;
  // Interactive /login writes to ~/.copilot/ (session-state and a token/host
  // file). An empty ~/.copilot/ directory - which any stray tool can create -
  // is NOT proof of auth, so require an artifact that the login flow itself
  // produces before reporting the agent as authenticated.
  return (
    existsSync(`${home}/.copilot/hosts.yml`) ||
    existsSync(`${home}/.copilot/config.json`) ||
    existsSync(`${home}/.copilot/session-state`)
  );
}

function installCommandFor(kind: CodingAgentKind): string | null {
  if (kind === "claude" || kind === "aisdk") return "curl -fsSL https://claude.ai/install.sh | bash";
  if (kind === "codex" || kind === "codex-aisdk") return "bun add -g @openai/codex";
  if (kind === "opencode") return "bun add -g opencode-ai";
  if (kind === "grok") return "curl -fsSL https://x.ai/cli/install.sh | bash";
  if (kind === "cursor") return "curl -fsSL https://cursor.com/install | bash";
  if (kind === "hermes") return "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
  if (kind === "copilot") return "npm install -g @github/copilot";
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
  if (kind === "copilot") return [copilotPath() ?? "copilot"];
  return null;
}

function authProviderFor(kind: CodingAgentKind): "claude" | "codex" | null {
  if (kind === "claude" || kind === "aisdk") return "claude";
  if (kind === "codex" || kind === "codex-aisdk") return "codex";
  return null;
}

/** Remove terminal control sequences before parsing or showing CLI output. */
export function cleanAuthOutput(value: string): string {
  return value
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function parseAuthOutput(
  provider: "claude" | "codex",
  raw: string,
): Pick<CodingAgentAuthSession, "authorizationUrl" | "userCode" | "needsCode"> {
  const output = cleanAuthOutput(raw);
  const authorizationUrl = output.match(/https:\/\/[^\s\x07\x1b]+/)?.[0];
  if (provider === "codex") {
    const userCode = output.match(/one-time code[\s\S]{0,160}?\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/i)?.[1];
    return { authorizationUrl, userCode, needsCode: false };
  }
  return {
    authorizationUrl,
    needsCode: /paste code here/i.test(output),
  };
}

function publicAuthSession(session: InternalAuthSession): CodingAgentAuthSession {
  const { process: _process, output: _output, ready: _ready, markReady: _markReady, expiresAt: _expiresAt, ...result } = session;
  return result;
}

function stopAuthSession(session: InternalAuthSession): void {
  if (session.status === "starting" || session.status === "waiting") {
    try { session.process.kill(); } catch {}
  }
}

function updateAuthSessionFromOutput(session: InternalAuthSession): void {
  const parsed = parseAuthOutput(session.provider, session.output);
  if (parsed.authorizationUrl) session.authorizationUrl = parsed.authorizationUrl;
  if (parsed.userCode) session.userCode = parsed.userCode;
  session.needsCode = parsed.needsCode;
  const ready = !!session.authorizationUrl && (session.provider === "claude" || !!session.userCode);
  if (ready && session.status === "starting") {
    session.status = "waiting";
    session.markReady();
  }
}

async function collectAuthOutput(
  session: InternalAuthSession,
  stream: ReadableStream<Uint8Array> | number | undefined,
): Promise<void> {
  if (!stream || typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      session.output = (session.output + decoder.decode(value, { stream: true })).slice(-AUTH_OUTPUT_LIMIT);
      updateAuthSessionFromOutput(session);
    }
  } catch {}
}

export async function startCodingAgentAuth(kind: CodingAgentKind): Promise<CodingAgentAuthSession> {
  const provider = authProviderFor(kind);
  if (!provider) throw new Error(`${CODING_AGENT_LABELS[kind]} does not support browser login yet`);
  const binary = provider === "claude" ? claudePath() : codexPath();
  if (!binary) throw new Error(`Install ${provider === "claude" ? "Claude" : "Codex"} before signing in`);

  for (const existing of authSessions.values()) {
    if (existing.provider === provider && (existing.status === "starting" || existing.status === "waiting")) {
      stopAuthSession(existing);
      authSessions.delete(existing.id);
    }
  }

  const argv = provider === "claude"
    ? [binary, "auth", "login", "--claudeai"]
    : [binary, "login", "--device-auth"];
  const proc = Bun.spawn(argv, {
    cwd: userHome(),
    env: { ...process.env, BROWSER: "true" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let markReady = () => {};
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const session: InternalAuthSession = {
    id: randomUUID(),
    kind,
    provider,
    status: "starting",
    needsCode: false,
    process: proc,
    output: "",
    ready,
    markReady,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
  };
  authSessions.set(session.id, session);
  void collectAuthOutput(session, proc.stdout);
  void collectAuthOutput(session, proc.stderr);
  void proc.exited.then((exitCode) => {
    if (session.status === "error") return;
    if (exitCode === 0) {
      session.status = "complete";
    } else if (session.status !== "complete") {
      const output = cleanAuthOutput(session.output).trim().split("\n").slice(-3).join(" ");
      session.status = "error";
      session.error = output || `${provider === "claude" ? "Claude" : "Codex"} login was cancelled`;
    }
    session.markReady();
  });
  setTimeout(() => {
    if (!authSessions.has(session.id)) return;
    if (session.status === "starting" || session.status === "waiting") {
      session.status = "error";
      session.error = "Login expired. Start again for a new code.";
      stopAuthSession(session);
      session.markReady();
    }
  }, AUTH_SESSION_TTL_MS);

  await Promise.race([
    session.ready,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (session.status === "starting" && !session.authorizationUrl) {
    stopAuthSession(session);
    session.status = "error";
    session.error = "The login page could not be prepared. Please try again.";
  }
  return publicAuthSession(session);
}

export function getCodingAgentAuth(id: string): CodingAgentAuthSession | null {
  const session = authSessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt && session.status !== "complete") {
    session.status = "error";
    session.error = "Login expired. Start again for a new code.";
    stopAuthSession(session);
  }
  return publicAuthSession(session);
}

export async function submitCodingAgentAuthCode(id: string, code: string): Promise<CodingAgentAuthSession> {
  const session = authSessions.get(id);
  if (!session) throw new Error("Login session not found. Start again.");
  if (session.provider !== "claude" || !session.needsCode) throw new Error("This login does not accept a code");
  if (session.status !== "waiting") throw new Error("This login is no longer waiting for a code");
  const value = code.trim();
  if (!value) throw new Error("Enter the code from Claude");
  const stdin = session.process.stdin;
  if (!stdin || typeof stdin === "number") throw new Error("Claude login is no longer accepting a code");
  session.needsCode = false;
  stdin.write(`${value}\n`);
  await stdin.flush();
  return publicAuthSession(session);
}

export function cancelCodingAgentAuth(id: string): void {
  const session = authSessions.get(id);
  if (!session) return;
  stopAuthSession(session);
  authSessions.delete(id);
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
    addAuth("Claude auth", hasClaudeAuth(), "use Login below or set ANTHROPIC_API_KEY");
    instructions.push("Use Login to sign in with Claude in your browser, or set ANTHROPIC_API_KEY.");
  } else if (kind === "codex" || kind === "codex-aisdk") {
    addBinary("Codex CLI", codexPath());
    addAuth("Codex auth", hasCodexAuth(), "use Login below or set OPENAI_API_KEY");
    instructions.push("Use Login to connect ChatGPT in your browser, or set OPENAI_API_KEY.");
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
  } else if (kind === "copilot") {
    addBinary("GitHub Copilot CLI", copilotPath());
    addAuth("Copilot auth", hasCopilotAuth(), "run 'copilot' and /login, or set COPILOT_GITHUB_TOKEN / GH_TOKEN with the Copilot Requests scope");
    instructions.push("Install Copilot CLI (npm install -g @github/copilot; requires Node 22+), then run 'copilot' once and /login, or set COPILOT_GITHUB_TOKEN (or GH_TOKEN) with the Copilot Requests scope.");
  } else {
    addBinary("Grok CLI", grokPath());
    addAuth("Grok auth", hasGrokAuth(), "run `grok` once or set XAI_API_KEY");
    instructions.push("Install Grok, then run `grok` once and sign in, or set XAI_API_KEY.");
  }

  return {
    configured: checks.every((c) => c.ok),
    lfgCapabilityAccess: lfgCapabilityAccess(kind),
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
  const opencode = opencodePath();
  const grok = grokPath();
  const cursor = cursorPath();
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
  const optionalMcpAgents: Array<[string, string | null, () => boolean]> = [
    ["OpenCode", opencode, hasOpencodeLfgMcp],
    ["Grok", grok, hasGrokLfgMcp],
    ["Cursor", cursor, hasCursorLfgMcp],
  ];
  for (const [label, binary, registered] of optionalMcpAgents) {
    const ok = registered();
    checks.push(binary
      ? { label: `${label} MCP`, ok, detail: ok ? "registered" : "not registered" }
      : { label: `${label} MCP`, ok: true, detail: `${label} CLI not installed` });
  }
  return [
    {
      key: "lfg-mcp",
      label: "LFG MCP",
      configured: checks.every((check) => check.ok),
      running: systemSetupRuns.has("lfg-mcp"),
      checks,
      instructions: [
        "Registers the local LFG MCP server with Claude, Codex, OpenCode, Grok, and Cursor when those CLIs are installed.",
      ],
      canAutoSetup: !!args && !!(claude || codex || opencode || grok || cursor),
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

function mergeJsonConfig(path: string, update: (current: Record<string, unknown>) => Record<string, unknown>): void {
  const parsed = readJson<Record<string, unknown>>(path);
  if (existsSync(path) && !parsed) {
    throw new Error(`Cannot update invalid JSON config: ${path}`);
  }
  const current = parsed ?? {};
  const next = update(current);
  writeFileSync(path, JSON.stringify(next, null, 2));
}

export function withOpencodeLfgMcp(current: Record<string, unknown>, args: string[]): Record<string, unknown> {
  const mcp = typeof current.mcp === "object" && current.mcp !== null
    ? current.mcp as Record<string, unknown>
    : {};
  return {
    ...current,
    mcp: {
      ...mcp,
      lfg: { type: "local", command: args, enabled: true },
    },
  };
}

export function withCursorLfgMcp(current: Record<string, unknown>, args: string[]): Record<string, unknown> {
  const mcpServers = typeof current.mcpServers === "object" && current.mcpServers !== null
    ? current.mcpServers as Record<string, unknown>
    : {};
  return {
    ...current,
    mcpServers: {
      ...mcpServers,
      lfg: { command: args[0], args: args.slice(1) },
    },
  };
}

async function installOpencodeMcp(args: string[]): Promise<void> {
  const path = join(userHome(), ".config", "opencode", "opencode.json");
  await mkdir(dirname(path), { recursive: true });
  mergeJsonConfig(path, (current) => withOpencodeLfgMcp(current, args));
}

function installGrokMcp(grok: string, args: string[]): void {
  commandOutput([grok, "mcp", "remove", "lfg", "--scope", "user"]);
  const out = commandOutput([grok, "mcp", "add", "lfg", "--scope", "user", "--", ...args]);
  if (!out.ok) throw new Error(out.text.trim() || "Grok MCP install failed");
}

async function installCursorMcp(args: string[]): Promise<void> {
  const path = join(userHome(), ".cursor", "mcp.json");
  await mkdir(dirname(path), { recursive: true });
  mergeJsonConfig(path, (current) => withCursorLfgMcp(current, args));
  const cursor = cursorPath();
  if (cursor) commandOutput([cursor, "mcp", "enable", "lfg"]);
}

export async function runSetupAction(key: string): Promise<void> {
  if (key !== "lfg-mcp") throw new Error(`unknown setup action "${key}"`);
  if (systemSetupRuns.has(key)) throw new Error(`${key} setup is already running`);
  const run = (async () => {
    const args = mcpCommandArgs();
    if (!args) throw new Error("Bun is required to register the LFG MCP server");
    const claude = claudePath();
    const codex = codexPath();
    const opencode = opencodePath();
    const grok = grokPath();
    const cursor = cursorPath();
    if (!claude && !codex && !opencode && !grok && !cursor) {
      throw new Error("Install a supported coding agent first, then register the LFG MCP server");
    }
    if (claude) installClaudeMcp(claude, args);
    if (codex) installCodexMcp(codex, args);
    if (opencode) await installOpencodeMcp(args);
    if (grok) installGrokMcp(grok, args);
    if (cursor) await installCursorMcp(args);
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
  if (kind === "copilot") return { LFG_INSTALL_COPILOT: "1" };
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

  setupLog = {
    running: true,
    kinds: [...uniqueKinds],
    lines: [],
    error: null,
    finishedAt: null,
  };
  appendSetupLog(
    `Installing ${uniqueKinds.map((kind) => CODING_AGENT_LABELS[kind]).join(", ")}…`,
  );

  const script = join(PATHS.root, "scripts", "setup.sh");
  const run = (async () => {
    const proc = Bun.spawn(["bash", script], {
      cwd: PATHS.root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...setupEnv },
    });
    const readLines = async (
      stream: ReadableStream<Uint8Array>,
      onLine: (line: string) => void,
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
      if (buffered.length) onLine(buffered);
    };
    let installSeen = false;
    const stderrLines: string[] = [];
    const stdout = readLines(proc.stdout, (line) => {
      appendSetupLog(line);
      const message = line.replace(/\x1b\[[0-9;]*m/g, "").replace(/^==>\s*/, "").trim();
      if (!message) return;
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
    });
    const stderr = readLines(proc.stderr, (line) => {
      appendSetupLog(line);
      stderrLines.push(line);
    });
    const [, , code] = await Promise.all([stdout, stderr, proc.exited]);
    if (code !== 0) {
      const detail = stderrLines
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim()
        .slice(0, 1000);
      throw new Error(detail || `setup exited ${code}`);
    }
    for (const kind of uniqueKinds) {
      setupProgress.set(kind, { percent: 95, label: "Verifying installation…" });
    }
  })();
  for (const kind of uniqueKinds) setupRuns.set(kind, run);
  try {
    await run;
    appendSetupLog("Done.");
  } catch (e) {
    setupLog.error = e instanceof Error ? e.message : String(e);
    appendSetupLog(`Error: ${setupLog.error}`);
    throw e;
  } finally {
    setupLog.running = false;
    setupLog.finishedAt = Date.now();
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
