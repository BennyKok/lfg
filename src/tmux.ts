// Map a live process to its tmux pane and inject input. Claude Code sessions
// run inside tmux panes; we discover the `claude` pid via pgrep/proc, walk up
// its parent chain to the pane's top process, and `send-keys` into that pane.
import { readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { reposRoot } from "./projects";

// Known-good Claude model alias to launch with when a caller doesn't specify
// one. Never launch a managed `claude` bare — see spawnManagedSession. Opus is
// the current most-capable widely-available model and the alias the `/model`
// command and lfg's picker both accept.
export const DEFAULT_MODEL = "opus";

// claude shows a blocking "Is this a project you trust?" dialog the first time
// it opens an untrusted cwd. It is NOT bypassed by --dangerously-skip-permissions
// and it renders BEFORE the TUI starts — so a spawned session hangs on it and
// never writes its pidfile, which means listSessions() can't resolve it and it
// silently never appears in the session list. Pre-accept trust for `cwd` in
// ~/.claude.json so the dialog never fires. Idempotent: a no-op once trusted.
export function ensureFolderTrusted(cwd: string): void {
  try {
    const cfgPath = `${homedir()}/.claude.json`;
    if (!existsSync(cfgPath)) return;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.projects ??= {};
    const p = cfg.projects[cwd] ?? {};
    if (p.hasTrustDialogAccepted === true) return; // already trusted
    p.hasTrustDialogAccepted = true;
    p.hasCompletedProjectOnboarding = true;
    if (!p.projectOnboardingSeenCount) p.projectOnboardingSeenCount = 1;
    cfg.projects[cwd] = p;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  } catch {
    // best-effort — if we can't patch the config the worst case is the old hang
  }
}

// cursor-agent shows a blocking "Workspace Trust Required" dialog the first time
// it opens an untrusted cwd — and its --trust flag only applies to --print mode,
// so a spawned TUI session hangs on the dialog forever, never runs a turn, and
// never writes its transcript (so it also never streams). Pre-write the trust
// marker cursor persists on accept: ~/.cursor/projects/<enc-cwd>/.workspace-trusted,
// where <enc-cwd> is the abs cwd with the leading slash dropped and remaining
// slashes turned into dashes. Idempotent; best-effort.
function ensureCursorFolderTrusted(cwd: string): void {
  try {
    if (!cwd.startsWith("/")) return;
    const enc = cwd.replace(/^\/+/, "").replace(/\//g, "-");
    const dir = `${homedir()}/.cursor/projects/${enc}`;
    const marker = `${dir}/.workspace-trusted`;
    if (existsSync(marker)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      marker,
      JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: cwd }, null, 2),
    );
  } catch {
    // best-effort — worst case is the old trust-dialog hang
  }
}

function addSessionEnv(argv: string[], sessionId?: string | null, user?: string | null): void {
  const i = argv.indexOf("new-session");
  if (i < 0) return;
  const env: string[] = [];
  if (sessionId) env.push("-e", `LFG_SESSION_ID=${sessionId}`);
  // The assigned user rides along so anything the session spawns (lfg MCP,
  // `lfg subagent`) can tag ITS children to the same user even when the parent
  // chain isn't resolvable at create time (headless/cron callers).
  if (user) env.push("-e", `LFG_USER=${user}`);
  if (env.length) argv.splice(i + 1, 0, ...env);
}

type AgentContainment = {
  name: string;
  cwd: string;
  lfgSessionId?: string | null;
  lfgUser?: string | null;
};

/**
 * Run a subagent as a transient user service in the aggregate agent slice.
 * A service (rather than a scope) gives systemd a main process: when it exits,
 * KillMode=control-group reaps helper daemons such as agent-browser. Blocking
 * the service's session bus also prevents Chromium from moving itself into an
 * unrestricted app-org.chromium scope outside the slice.
 */
export function containedAgentCommand(command: string[], opts: AgentContainment): string[] {
  if (process.platform !== "linux") return command;
  const systemdRun = Bun.which("systemd-run") ?? "/usr/bin/systemd-run";
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const argv = [
    systemdRun,
    "--user",
    "--quiet",
    "--pty",
    "--wait",
    "--collect",
    `--unit=lfg-agent-${opts.name}`,
    "--slice=lfg-agents.slice",
    `--working-directory=${opts.cwd}`,
    "--property=Type=exec",
    "--property=KillMode=control-group",
    "--property=OOMScoreAdjust=200",
    `--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/lfg-agent-no-session-bus`,
    `--setenv=AGENT_BROWSER_SESSION=${opts.name}`,
    "--setenv=AGENT_BROWSER_IDLE_TIMEOUT_MS=300000",
  ];
  if (process.env.PATH) argv.push(`--setenv=PATH=${process.env.PATH}`);
  if (opts.lfgSessionId) argv.push(`--setenv=LFG_SESSION_ID=${opts.lfgSessionId}`);
  if (opts.lfgUser) argv.push(`--setenv=LFG_USER=${opts.lfgUser}`);
  return [...argv, "--", ...command];
}

function containTmuxCommand(
  argv: string[],
  executable: string,
  enabled: boolean | undefined,
  opts: AgentContainment,
): void {
  if (!enabled) return;
  const commandIndex = argv.indexOf(executable);
  if (commandIndex < 0) throw new Error(`agent executable not found in tmux argv: ${executable}`);
  argv.splice(commandIndex, argv.length - commandIndex, ...containedAgentCommand(argv.slice(commandIndex), opts));
}

// Resolve the `claude` executable to an absolute path. We must NOT rely on a
// bare `claude` in the spawn: when lfg runs as a systemd service its PATH
// often lacks ~/.local/bin, so `tmux new-session … claude` can't exec claude
// and the session dies on the spot (looks like "can't create a session"). Bun
// .which() honours the current PATH; fall back to the known install locations.
let _claudeBin: string | null = null;
export function claudeBin(): string {
  if (_claudeBin) return _claudeBin;
  const onPath = Bun.which("claude");
  if (onPath) return (_claudeBin = onPath);
  const home = process.env.HOME ?? homedir();
  for (const p of [
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(p)) return (_claudeBin = p);
  }
  return (_claudeBin = "claude"); // last resort: let the failure surface
}

let _codexBin: string | null = null;
export function codexBin(): string {
  if (_codexBin) return _codexBin;
  const onPath = Bun.which("codex");
  if (onPath) return (_codexBin = onPath);
  const home = process.env.HOME ?? homedir();
  for (const p of [
    `${home}/.local/bin/codex`,
    `${home}/.bun/bin/codex`,
    "/usr/local/bin/codex",
  ]) {
    if (existsSync(p)) return (_codexBin = p);
  }
  return (_codexBin = "codex");
}

let _grokBin: string | null = null;
export function grokBin(): string {
  if (_grokBin) return _grokBin;
  const onPath = Bun.which("grok");
  if (onPath) return (_grokBin = onPath);
  const home = process.env.HOME ?? homedir();
  for (const p of [
    `${home}/.local/bin/grok`,
    `${home}/.bun/bin/grok`,
    `${home}/.grok/downloads/grok-linux-x86_64`,
    "/usr/local/bin/grok",
  ]) {
    if (existsSync(p)) return (_grokBin = p);
  }
  return (_grokBin = "grok");
}

let _copilotBin: string | null = null;
export function copilotBin(): string {
  if (_copilotBin) return _copilotBin;
  const onPath = Bun.which("copilot");
  if (onPath) return (_copilotBin = onPath);
  const home = process.env.HOME ?? homedir();
  const candidates = [
    process.env.LFG_COPILOT_PATH ?? "",
    `${home}/.local/bin/copilot`,
    `${home}/.bun/bin/copilot`,
    "/usr/local/bin/copilot",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return (_copilotBin = p);
  }
  return (_copilotBin = "copilot");
}

let _cursorBin: string | null = null;
function isGrokAgentPath(path: string): boolean {
  try {
    const real = realpathSync(path);
    return real.includes("/.grok/") || real.endsWith("/grok-linux-x86_64");
  } catch {
    return path.includes("/.grok/");
  }
}

export function cursorBin(): string {
  if (_cursorBin) return _cursorBin;
  const cursorAgent = Bun.which("cursor-agent");
  if (cursorAgent) return (_cursorBin = cursorAgent);
  const agentOnPath = Bun.which("agent");
  if (agentOnPath && !isGrokAgentPath(agentOnPath)) return (_cursorBin = agentOnPath);
  const home = process.env.HOME ?? homedir();
  for (const p of [
    process.env.LFG_CURSOR_PATH ?? "",
    `${home}/.local/bin/cursor-agent`,
    `${home}/.bun/bin/cursor-agent`,
    "/usr/local/bin/cursor-agent",
    `${home}/.local/bin/agent`,
    `${home}/.bun/bin/agent`,
    "/usr/local/bin/agent",
  ]) {
    if (p && existsSync(p) && !isGrokAgentPath(p)) return (_cursorBin = p);
  }
  return (_cursorBin = "cursor-agent");
}

let _hermesBin: string | null = null;
export function hermesBin(): string {
  if (_hermesBin) return _hermesBin;
  const onPath = Bun.which("hermes");
  if (onPath) return (_hermesBin = onPath);
  const home = process.env.HOME ?? homedir();
  for (const p of [
    process.env.LFG_HERMES_PATH ?? "",
    `${home}/.local/bin/hermes`,
    `${home}/.bun/bin/hermes`,
    "/usr/local/bin/hermes",
  ]) {
    if (p && existsSync(p)) return (_hermesBin = p);
  }
  return (_hermesBin = "hermes");
}

// Spawned agents run with cwd set to one repo, but Claude Code scopes tool
// access to the cwd tree — which sandboxes the agent to that single repo. The
// agents are trusted operators of this whole box, so grant tool access to the
// repos root (every repo under LFG_REPOS_ROOT) via --add-dir. Override the root
// with LFG_REPOS_ROOT if the repos live elsewhere.
function paneMap(): Map<number, string> {
  const m = new Map<number, string>();
  try {
    const r = Bun.spawnSync([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_pid} #{session_name}:#{window_index}.#{pane_index}",
    ]);
    const out = new TextDecoder().decode(r.stdout);
    for (const line of out.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const pid = Number(line.slice(0, sp));
      const target = line.slice(sp + 1).trim();
      if (pid && target) m.set(pid, target);
    }
  } catch {}
  return m;
}

function ppidOf(pid: number): number | null {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm can contain spaces
    // and parens, so split after the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    const rest = stat.slice(rparen + 2).split(" ");
    const ppid = Number(rest[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

// A subagent launched via `containedAgentCommand` runs as a systemd transient
// service (`systemd-run --user --unit=lfg-agent-<tmuxName> --slice=lfg-agents.slice`).
// systemd reparents it under the `systemd --user` manager, so its /proc parent
// chain never passes through the tmux pane pid — the ppid walk below can't find
// the pane. But the cgroup records the unit, and by construction the unit suffix
// IS the tmux session name (see containedAgentCommand). Recover it from there.
function tmuxSessionFromAgentCgroup(pid: number): string | null {
  try {
    const cg = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const m = cg.match(/lfg-agent-([^./\s]+)\.service/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function tmuxTargetForPid(pid: number | null): string | null {
  if (!pid) return null;
  const panes = paneMap();
  let cur: number | null = pid;
  for (let i = 0; i < 12 && cur && cur > 1; i++) {
    if (panes.has(cur)) return panes.get(cur) as string;
    cur = ppidOf(cur);
  }
  // Fallback for slice-contained subagents whose parent chain leaves the pane
  // tree (see tmuxSessionFromAgentCgroup). Map the cgroup unit → its tmux
  // session's pane target. The pane still runs the `systemd-run` wrapper, so it
  // is the correct capture/send target for the agent's TUI.
  const session = tmuxSessionFromAgentCgroup(pid);
  if (session) {
    const prefix = `${session}:`;
    for (const target of panes.values()) {
      if (target.startsWith(prefix)) return target;
    }
  }
  return null;
}

export function tmuxHasSession(name: string): boolean {
  try {
    return Bun.spawnSync(["tmux", "has-session", "-t", `=${name}`]).exitCode === 0;
  } catch {
    return false;
  }
}

// Close a Claude session by killing its pane. The `claude` process gets a
// SIGHUP and exits, so the session drops out of the list on the next poll. We
// kill the pane (not the whole tmux session) so any other panes the user has
// in that session survive.
export function tmuxKillPane(target: string): boolean {
  try {
    return Bun.spawnSync(["tmux", "kill-pane", "-t", target]).exitCode === 0;
  } catch {
    return false;
  }
}

// Tear down a whole tmux session by name — the clean teardown for a session
// lfg started itself (one session == one managed claude, no sibling panes to
// preserve, unlike tmuxKillPane).
export function tmuxKillSession(name: string): boolean {
  try {
    return Bun.spawnSync(["tmux", "kill-session", "-t", `=${name}`]).exitCode === 0;
  } catch {
    return false;
  }
}

// pane_pid of a session's first pane. When the session was created with a
// command (no shell wrapper) this is the command's pid directly.
export function panePidForSession(name: string): number | null {
  try {
    const r = Bun.spawnSync([
      "tmux",
      "list-panes",
      "-t",
      `=${name}`,
      "-F",
      "#{pane_pid}",
    ]);
    if (r.exitCode !== 0) return null;
    const pid = Number(new TextDecoder().decode(r.stdout).split("\n")[0]?.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Launch an interactive `claude` in a fresh detached tmux session so the rest
// of lfg (session list, prompt detection, send/answer) can drive it. The
// initial instruction is passed as claude's positional prompt arg (after a `--`
// so the variadic --add-dir doesn't eat it), which the TUI auto-submits on
// boot — robust, unlike send-keys which races the splash screen and silently
// drops keys on a cold start. The instruction points at a brief file rather
// than inlining a huge prompt.
export function spawnAgentSession(opts: {
  name: string;
  cwd: string;
  briefPath: string;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  ensureFolderTrusted(opts.cwd);
  const create = Bun.spawnSync([
    "tmux",
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    claudeBin(),
    "--dangerously-skip-permissions",
    "--add-dir",
    reposRoot(),
    // `--` terminates option parsing: --add-dir is variadic and otherwise
    // greedily swallows the positional prompt as a second directory, leaving
    // the TUI at an empty composer (the brief never gets submitted).
    "--",
    `Read the task brief at ${opts.briefPath} and carry it out end-to-end.`,
  ]);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

// Start an interactive `claude` in a fresh detached tmux session that lfg
// owns and drives. Like spawnAgentSession but for a user-initiated session: the
// first prompt is optional (omit it to land at an empty composer). The caller
// resolves the new sessionId from panePidForSession(name) once claude writes
// its pidfile.
// Map lfg's shared thinking-level vocabulary (none|minimal|low|medium|high|xhigh,
// the same set Codex uses for reasoning_effort) onto Claude's `effort` levels
// (low|medium|high|xhigh|max). Claude has no "none"/"minimal" effort, so collapse
// those to the lowest real level rather than reject them — keeps a single shared
// thinkingLevel meaningful across both Codex and Claude sessions. Returns
// undefined for an empty/unknown level so the model/CLI default stands.
export function claudeEffortFor(level?: string): string | undefined {
  if (!level) return undefined;
  if (level === "none" || level === "minimal") return "low";
  if (["low", "medium", "high", "xhigh", "max"].includes(level)) return level;
  return undefined;
}

export function spawnManagedSession(opts: {
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  // When set, resume the on-disk transcript with this sessionId (`claude
  // --resume <id>`) instead of starting a fresh conversation — the way lfg
  // brings a closed/dead session back after the box (and its tmux server +
  // claude procs) was rebooted. Claude continues the conversation into a NEW
  // sessionId/transcript, so the caller resolves the live id from the pidfile
  // afterwards (same as a fresh spawn). The full prior history is preserved.
  resume?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  containInAgentSlice?: boolean;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  ensureFolderTrusted(opts.cwd);
  const argv = ["tmux", "new-session", "-d", "-s", opts.name, "-c", opts.cwd,
    claudeBin(), "--dangerously-skip-permissions", "--add-dir", reposRoot()];
  // Resume the prior conversation when asked. Placed before --model so the flags
  // read like relaunchSessionWithModel's argv; order is irrelevant to claude.
  if (opts.resume && opts.resume.trim()) argv.push("--resume", opts.resume.trim());
  // ALWAYS pin a model. A bare `claude` inherits Claude Code's saved global
  // default, which can silently rot — when Anthropic retires/disables that
  // model (e.g. the Fable off-switch), every inheriting session boots straight
  // into "model unavailable" and freezes, replaying the error on every turn.
  // An explicit --model is the only thing that overrides it. DEFAULT_MODEL is a
  // known-good fallback when the caller didn't pick one.
  argv.push("--model", opts.model || DEFAULT_MODEL);
  // Pin the reasoning effort when the caller asked for one (thinking mode). The
  // claude CLI exposes this as `--effort <level>`; map our shared thinking-level
  // vocabulary onto it (see claudeEffortFor). Omitted → CLI default effort.
  const effort = claudeEffortFor(opts.thinkingLevel);
  if (effort) argv.push("--effort", effort);
  // `--` terminates option parsing so the variadic --add-dir can't swallow the
  // positional prompt as a second directory (which strands the new session at
  // an empty composer — the first message never gets submitted).
  if (opts.prompt && opts.prompt.trim()) argv.push("--", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId, opts.lfgUser);
  containTmuxCommand(argv, claudeBin(), opts.containInAgentSlice, opts);
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

// Switch a running Claude session's model by RELAUNCHING its pane on the new
// model, resuming the same transcript (`--resume <id>`). This is the heavy
// hammer for a session whose model became invalid mid-flight: when the launch
// model is unavailable, Claude Code rejects every turn *before* it processes an
// injected `/model` slash command, so the in-place switch (see serve's /model
// endpoint) silently no-ops ("Kept model as <dead model>"). A fresh process
// with an explicit --model is the only thing that takes. `--resume` preserves
// the full conversation, so the build picks up where it froze. respawn-pane
// keeps the same tmux pane/name, so the managed registry and live view stay
// bound. No prompt is re-submitted — it lands at the composer, ready to go.
export function relaunchSessionWithModel(opts: {
  tmuxTarget: string;
  cwd: string;
  sessionId: string;
  model: string;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  ensureFolderTrusted(opts.cwd);
  const r = Bun.spawnSync([
    "tmux", "respawn-pane", "-k", "-c", opts.cwd, "-t", opts.tmuxTarget,
    claudeBin(), "--dangerously-skip-permissions", "--add-dir", reposRoot(),
    "--resume", opts.sessionId, "--model", opts.model,
  ]);
  if (r.exitCode !== 0)
    return { ok: false, error: dec.decode(r.stderr) || "respawn-pane failed" };
  return { ok: true };
}

export function spawnManagedCodexSession(opts: {
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  containInAgentSlice?: boolean;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  const argv = [
    "tmux",
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    codexBin(),
    "--cd",
    opts.cwd,
    "--sandbox",
    "danger-full-access",
    "--ask-for-approval",
    "never",
    "--add-dir",
    reposRoot(),
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.thinkingLevel) argv.push("-c", `reasoning_effort=${JSON.stringify(opts.thinkingLevel)}`);
  if (opts.prompt && opts.prompt.trim()) argv.push("--", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId, opts.lfgUser);
  containTmuxCommand(argv, codexBin(), opts.containInAgentSlice, opts);
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

export function spawnManagedGrokSession(opts: {
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  thinkingLevel?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  containInAgentSlice?: boolean;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  const argv = [
    "tmux",
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    grokBin(),
    "--cwd",
    opts.cwd,
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (opts.model) argv.push("--model", opts.model);
  const effort = claudeEffortFor(opts.thinkingLevel);
  if (effort) argv.push("--effort", effort);
  if (opts.prompt && opts.prompt.trim()) argv.push("--", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId, opts.lfgUser);
  containTmuxCommand(argv, grokBin(), opts.containInAgentSlice, opts);
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

export type ManagedCopilotSessionOptions = {
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  containInAgentSlice?: boolean;
};

// The Copilot TUI has two prompt-delivery flags:
//   -p / --prompt <text>      programmatic one-shot; exits after the turn
//   -i / --interactive <text> starts interactive mode and auto-executes <text>
// LFG wants a long-lived, steerable session, so use -i. It preserves the whole
// downstream contract (send/steer/answer) that the rest of tmux.ts drives.
//
// --allow-all-tools bypasses per-tool approvals. GitHub explicitly recommends
// it only in isolated environments; LFG's agent slice is resource-only, so it
// is opt-in through LFG_COPILOT_ALLOW_ALL_TOOLS=1 rather than always-on.
export function managedCopilotSessionArgv(opts: ManagedCopilotSessionOptions): string[] {
  const argv = [
    "tmux",
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    copilotBin(),
  ];
  if (process.env.LFG_COPILOT_ALLOW_ALL_TOOLS === "1") argv.push("--allow-all-tools");
  if (opts.model) argv.push("--model", opts.model);
  if (opts.prompt && opts.prompt.trim()) argv.push("-i", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId, opts.lfgUser);
  return argv;
}

export function spawnManagedCopilotSession(opts: ManagedCopilotSessionOptions): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  const argv = managedCopilotSessionArgv(opts);
  containTmuxCommand(argv, copilotBin(), opts.containInAgentSlice, opts);
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

export type ManagedCursorSessionOptions = {
  name: string;
  cwd: string;
  prompt?: string;
  model?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  nativeSessionId?: string;
  containInAgentSlice?: boolean;
};

export function managedCursorSessionArgv(opts: ManagedCursorSessionOptions): string[] {
  const argv = [
    "tmux",
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    cursorBin(),
    "--yolo",
    "--sandbox",
    "disabled",
  ];
  if (opts.nativeSessionId) argv.push("--resume", opts.nativeSessionId);
  if (opts.model && opts.model !== "auto") argv.push("--model", opts.model);
  if (opts.prompt && opts.prompt.trim()) argv.push(opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId, opts.lfgUser);
  return argv;
}

export function cursorChatIdFromOutput(output: string): string | null {
  return output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)?.[0] ?? null;
}

export function spawnManagedCursorSession(opts: ManagedCursorSessionOptions): {
  ok: boolean;
  error?: string;
  nativeSessionId?: string;
} {
  const dec = new TextDecoder();
  // Pre-accept workspace trust so the TUI doesn't hang on the trust dialog
  // (which would also block the transcript that the live view streams). `--yolo`
  // suppresses Cursor's per-command approval selector; `--sandbox disabled`
  // alone still asks before shell calls and can strand a live session mid-turn.
  ensureCursorFolderTrusted(opts.cwd);
  // Allocate Cursor's native chat id before starting the TUI. Discovering it as
  // "the newest transcript in cwd" races with old chats: until the new file is
  // created, newest is necessarily a previous session and the live view
  // backfills that conversation. An explicit id makes the mapping deterministic.
  const chat = Bun.spawnSync({
    cmd: [cursorBin(), "create-chat"],
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (chat.exitCode !== 0) {
    return { ok: false, error: dec.decode(chat.stderr) || "failed to create cursor chat" };
  }
  const nativeSessionId = cursorChatIdFromOutput(dec.decode(chat.stdout));
  if (!nativeSessionId) return { ok: false, error: "cursor create-chat returned no chat id" };
  const argv = managedCursorSessionArgv({ ...opts, nativeSessionId });
  containTmuxCommand(argv, cursorBin(), opts.containInAgentSlice, opts);
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true, nativeSessionId };
}

export function spawnManagedHermesSession(opts: {
  name: string;
  cwd: string;
  model?: string;
  provider?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  const argv = [
    "tmux",
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    hermesBin(),
    "--yolo",
    "--cli",
    "chat",
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.provider) argv.push("--provider", opts.provider);
  addSessionEnv(argv, opts.lfgSessionId, opts.lfgUser);
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

// Spawn a headless "aisdk" session: the lfg `aisdk-session` harness, supervised
// by a tmux session. The pane is only a lifecycle handle (survives serve restarts
// + reuses tmuxKillSession teardown) — I/O happens via the registry/command files
// and the transcript, not the pane. We run it with the same bun runtime that's
// running serve, pointed at this repo's cli.ts.
export function spawnManagedAisdkSession(opts: {
  name: string;
  cwd: string;
  prompt?: string;
  model: string;
  sessionId: string;
  thinkingLevel?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  containInAgentSlice?: boolean;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  // The provider drives the bundled claude binary, which still honors the trust
  // dialog — pre-accept it so the first turn doesn't hang.
  ensureFolderTrusted(opts.cwd);
  // Spawn the harness module directly (not via the lfg CLI) so it has no
  // dependency on the rest of the command surface.
  const harnessPath = `${import.meta.dir}/agents/backends/aisdk-session.ts`;
  const argv = [
    "tmux", "new-session", "-d", "-s", opts.name, "-c", opts.cwd,
    process.execPath, harnessPath,
    "--session", opts.sessionId,
    "--model", opts.model,
    "--cwd", opts.cwd,
    "--tmux", opts.name,
  ];
  // Forward the requested thinking level; the harness maps it onto the
  // claude-code provider's `effort` option (see aisdk-session.ts).
  if (opts.thinkingLevel) argv.push("--thinking-level", opts.thinkingLevel);
  if (opts.prompt && opts.prompt.trim()) argv.push("--", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId ?? opts.sessionId, opts.lfgUser);
  containTmuxCommand(argv, process.execPath, opts.containInAgentSlice, {
    ...opts,
    lfgSessionId: opts.lfgSessionId ?? opts.sessionId,
  });
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

// Spawn a headless "codex-aisdk" session: the lfg codex-aisdk-session harness,
// supervised by a tmux session. Mirrors spawnManagedAisdkSession exactly except
// it points at the codex harness and passes the control-plane KEY (--key) rather
// than a deterministic --session id — codex assigns its thread id only after the
// first turn, so the key is all we know up front (see the harness header).
export function spawnManagedCodexAisdkSession(opts: {
  name: string;
  cwd: string;
  prompt?: string;
  model: string;
  key: string;
  thinkingLevel?: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  containInAgentSlice?: boolean;
  // When set, resume this existing codex rollout/thread instead of starting a
  // fresh persistent thread — the harness seeds its threadId with it.
  resume?: string;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  // Harmless for codex: ensureFolderTrusted only patches ~/.claude.json and is a
  // no-op when that file (or the project entry) is absent. Codex doesn't gate on
  // it, but keeping it costs nothing and keeps this in lockstep with the Claude
  // spawn helper.
  ensureFolderTrusted(opts.cwd);
  // Spawn the harness module directly (not via the lfg CLI) so it has no
  // dependency on the rest of the command surface.
  const harnessPath = `${import.meta.dir}/agents/backends/codex-aisdk-session.ts`;
  const argv = [
    "tmux", "new-session", "-d", "-s", opts.name, "-c", opts.cwd,
    process.execPath, harnessPath,
    "--key", opts.key,
    "--model", opts.model,
    "--cwd", opts.cwd,
    "--tmux", opts.name,
  ];
  if (opts.thinkingLevel) argv.push("--thinking-level", opts.thinkingLevel);
  if (opts.resume) argv.push("--resume", opts.resume);
  if (opts.prompt && opts.prompt.trim()) argv.push("--", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId ?? opts.key, opts.lfgUser);
  containTmuxCommand(argv, process.execPath, opts.containInAgentSlice, {
    ...opts,
    lfgSessionId: opts.lfgSessionId ?? opts.key,
  });
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

// Spawn a headless "opencode" session: the lfg opencode-aisdk-session harness,
// supervised by a tmux session. Mirrors spawnManagedCodexAisdkSession exactly
// except it points at the opencode harness. Like codex-aisdk it passes a
// control-plane KEY (--key) — but for opencode the key is ALSO the transcript id
// (the harness owns the transcript file it writes), so serve can treat the
// returned sessionId as == key (see the harness header).
export function spawnManagedOpencodeAisdkSession(opts: {
  name: string;
  cwd: string;
  prompt?: string;
  model: string;
  key: string;
  lfgSessionId?: string;
  lfgUser?: string | null;
  resume?: string;
  containInAgentSlice?: boolean;
}): { ok: boolean; error?: string } {
  const dec = new TextDecoder();
  // Harmless for opencode: ensureFolderTrusted only patches ~/.claude.json and
  // is a no-op when that file (or the project entry) is absent. Kept in lockstep
  // with the other AI-SDK spawn helpers.
  ensureFolderTrusted(opts.cwd);
  // Spawn the harness module directly (not via the lfg CLI) so it has no
  // dependency on the rest of the command surface.
  const harnessPath = `${import.meta.dir}/agents/backends/opencode-aisdk-session.ts`;
  const argv = [
    "tmux", "new-session", "-d", "-s", opts.name, "-c", opts.cwd,
    process.execPath, harnessPath,
    "--key", opts.key,
    "--model", opts.model,
    "--cwd", opts.cwd,
    "--tmux", opts.name,
  ];
  if (opts.resume) argv.push("--resume", opts.resume);
  if (opts.prompt && opts.prompt.trim()) argv.push("--", opts.prompt);
  addSessionEnv(argv, opts.lfgSessionId ?? opts.key, opts.lfgUser);
  containTmuxCommand(argv, process.execPath, opts.containInAgentSlice, {
    ...opts,
    lfgSessionId: opts.lfgSessionId ?? opts.key,
  });
  const create = Bun.spawnSync(argv);
  if (create.exitCode !== 0)
    return { ok: false, error: dec.decode(create.stderr) || "new-session failed" };
  return { ok: true };
}

// Codex 0.135 can show an update selector before the composer, which strands a
// dashboard-spawned pane until someone manually presses "Skip". Dismiss only
// that exact startup prompt; normal permission/question selectors are left for
// the dashboard's prompt-answer flow.
export function dismissCodexUpdatePrompt(target: string): boolean {
  const pane = capturePane(target);
  if (!pane || !/Update available!/i.test(pane) || !/\b2\.\s+Skip\b/.test(pane))
    return false;
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", "2"]);
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
  return true;
}

// cursor-agent shows a blocking "⚠ Workspace Trust Required" dialog before the
// composer for any untrusted cwd. spawnManagedCursorSession pre-writes the trust
// marker so it normally never appears, but this is the belt-and-suspenders: if a
// dialog slips through (marker race, a cwd whose encoding we didn't anticipate,
// or a session spawned before the marker fix), a dashboard-spawned pane would
// hang here forever, never run a turn, and never write the transcript the live
// view streams — i.e. "cursor streaming is broken". Answer it by pressing `a`
// ("Trust this workspace"). Only that exact dialog; other selectors are left for
// the dashboard's prompt-answer flow.
export function dismissCursorTrustPrompt(target: string): boolean {
  const pane = capturePane(target);
  if (!pane || !/Workspace Trust Required/i.test(pane) || !/\[a\]\s+Trust this workspace/i.test(pane))
    return false;
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", "a"]);
  return true;
}

// Claude Code 2.1+ interrupts `claude --resume` of a large/old transcript with a
// blocking selector ("Resume from summary (recommended) / Resume full session
// as-is / Don't ask me again") before it reaches the composer. A managed resume
// has nobody to answer it, so the pane freezes at the menu forever and the
// session never comes alive — every resume of a big/old session hangs, which
// reads as "resume is completely broken". Watch the freshly-spawned pane and
// auto-pick option 2, "Resume full session as-is", which preserves the full
// prior history — the exact contract spawnManagedSession/relaunch document (and
// what resume meant before this gate existed). Returns:
//   "dismissed" — gate found and answered
//   "ready"     — no gate; composer came up on its own (small/new session)
//   "timeout"   — neither within the budget (caller proceeds anyway)
export async function dismissResumeSummaryGate(
  target: string,
  opts: { tries?: number; delayMs?: number } = {},
): Promise<"dismissed" | "ready" | "timeout"> {
  const tries = opts.tries ?? 24; // ~6s at 250ms — covers a cold, heavy transcript
  const delayMs = opts.delayMs ?? 250;
  for (let i = 0; i < tries; i++) {
    const pane = capturePane(target);
    if (pane && /Resume from summary/i.test(pane) && /Resume full session as-is/i.test(pane)) {
      // -l sends the literal "2" (numeric selection), then Enter confirms — same
      // shape as dismissCodexUpdatePrompt.
      Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", "2"]);
      Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
      return "dismissed";
    }
    // Composer reached without a gate → nothing to answer, bail early so small
    // sessions don't eat the full timeout.
    if (pane && /bypass permissions on|\? for shortcuts/i.test(pane)) return "ready";
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return "timeout";
}

export function capturePane(target: string): string | null {
  try {
    const r = Bun.spawnSync(["tmux", "capture-pane", "-t", target, "-p"]);
    if (r.exitCode !== 0) return null;
    return new TextDecoder().decode(r.stdout);
  } catch {
    return null;
  }
}

// Capture a pane (no line-join) with some scrollback. We deliberately do NOT
// pass -J: long URLs are often broken by the app's own hard wrap, not tmux
// auto-wrap, so -J can't rejoin them — link reconstruction handles the joining
// itself (see src/links.ts) and needs the rows kept separate.
export function capturePaneScroll(target: string, scrollback = 200): string | null {
  try {
    const r = Bun.spawnSync([
      "tmux", "capture-pane", "-t", target, "-p", "-S", `-${scrollback}`,
    ]);
    if (r.exitCode !== 0) return null;
    return new TextDecoder().decode(r.stdout);
  } catch {
    return null;
  }
}

// Same, but with escape sequences preserved (-e) so OSC 8 hyperlink targets
// survive — those carry the full URL regardless of how it visually wraps.
export function capturePaneEscaped(target: string, scrollback = 200): string | null {
  try {
    const r = Bun.spawnSync([
      "tmux", "capture-pane", "-t", target, "-p", "-e", "-S", `-${scrollback}`,
    ]);
    if (r.exitCode !== 0) return null;
    return new TextDecoder().decode(r.stdout);
  } catch {
    return null;
  }
}

// A pane's current column count — the wrap width link reconstruction joins on.
export function paneWidth(target: string): number | null {
  try {
    const r = Bun.spawnSync([
      "tmux", "display-message", "-p", "-t", target, "#{pane_width}",
    ]);
    if (r.exitCode !== 0) return null;
    const n = Number(new TextDecoder().decode(r.stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export type PromptOption = { index: number; label: string; selected: boolean };
export type PanePrompt = { question: string; options: PromptOption[] };

// Detect a Claude Code interactive selector in a pane capture (permission /
// plan-approval / trust dialogs AND AskUserQuestion). They render as numbered
// options with a "❯" cursor on the active one — the cursor is what tells a live
// prompt apart from a static numbered list in the transcript above.
//
// Permission prompts pack options on adjacent lines; AskUserQuestion puts a
// wrapped, indented description under each option (so the numbered lines are
// NOT contiguous). We therefore don't require contiguity — we gather every
// numbered line and group by consecutive numbering (a reset to a lower number
// starts a new group), then pick the bottom-most group whose active option
// carries the cursor.
const OPT_RE = /^\s*(❯|›)?\s*(\d+)\.\s+(\S.*?)\s*$/;

function parseCursorApprovalPrompt(lines: string[]): PanePrompt | null {
  const questionLine = lines.findIndex((line) => /^\s*Run this command\?\s*$/i.test(line));
  if (questionLine < 0) return null;
  const window = lines.slice(questionLine + 1, questionLine + 8);
  if (!window.some((line) => /Not in allowlist/i.test(line))) return null;

  const options: PromptOption[] = [
    { index: 0, label: "Run once", selected: false },
    { index: 1, label: "Add command to allowlist", selected: false },
    { index: 2, label: "Run everything", selected: false },
    { index: 3, label: "Skip", selected: false },
  ];

  for (const line of window) {
    const selected = /^\s*→/.test(line);
    if (/Run \(once\)/i.test(line)) options[0].selected = selected;
    else if (/Add Shell\(/i.test(line)) options[1].selected = selected;
    else if (/Run Everything/i.test(line)) options[2].selected = selected;
    else if (/Skip/i.test(line)) options[3].selected = selected;
  }

  return { question: "Run this command?", options };
}

export function parsePrompt(pane: string): PanePrompt | null {
  const lines = pane.replace(/\s+$/, "").split("\n");
  const cursorPrompt = parseCursorApprovalPrompt(lines);
  if (cursorPrompt) return cursorPrompt;

  type Hit = { line: number; index: number; label: string; selected: boolean };
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPT_RE);
    if (!m) continue;
    hits.push({ line: i, index: Number(m[2]), label: m[3].trim(), selected: !!m[1] });
  }
  if (!hits.length) return null;
  // Split into runs where the option number increments by exactly 1.
  const groups: Hit[][] = [];
  for (const h of hits) {
    const g = groups[groups.length - 1];
    if (g && h.index === g[g.length - 1].index + 1) g.push(h);
    else groups.push([h]);
  }
  let group: Hit[] | null = null;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].length >= 2 && groups[i].some((h) => h.selected)) {
      group = groups[i];
      break;
    }
  }
  if (!group) return null;
  const options: PromptOption[] = group.map((h) => ({
    index: h.index,
    label: h.label,
    selected: h.selected,
  }));
  // Question = nearest meaningful line above the first option. Skip blank
  // lines, separators, and the AskUserQuestion multi-question nav bar
  // (e.g. "←  ☐ Multi-box future  ☐ Durability  ✔ Submit  →").
  let question = "";
  const start = group[0].line;
  for (let i = start - 1; i >= 0 && i >= start - 6; i--) {
    const t = lines[i].trim();
    if (!t || /^[╌─_=-]+$/.test(t)) continue;
    if (t.startsWith("←") || /✔\s*Submit/.test(t)) continue;
    question = t;
    break;
  }
  return { question, options };
}

// True when an AskUserQuestion selector is open in the pane, even when its
// option layout is unparseable (preview / multi-select). Keys off the stable
// footer the question dialog renders ("Enter to select · ↑/↓ to navigate · …
// Esc to cancel") — distinct from the composer and from permission prompts.
// Used to gate the number-key answer fallback so a stray keystroke can't land
// in the composer when no selector is up.
export function questionSelectorOpen(pane: string): boolean {
  return /Enter to select/i.test(pane) && /to navigate/i.test(pane);
}

// Claude is mid-turn when the TUI pins its live spinner meter just above the
// composer, e.g. "✢ Cerebrating… (2m 34s · ↓ 9.7k tokens)". That meter is
// present for the whole turn (the verb is random, but the "(<elapsed> · …
// tokens)" shape is stable), and a finished turn collapses it to a past-tense
// summary with no parens ("✻ Baked for 18m 45s"). We previously relied solely
// on the "esc to interrupt" footer hint, but that footer rotates through other
// hints mid-turn ("← for agents", "PR #96", tips…), so the hint blinks in and
// out and the busy state flickered. Match the meter as the primary signal and
// keep the hint as a fallback (covers the first frame before tokens render).
const BUSY_METER = /\(\d+m?\s?\d*s\b[^)]*\btokens?\b/i;
const GROK_SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧]";
const GROK_QUEUED_WORK = new RegExp(`${GROK_SPINNER}\\s+MCP\\s+\\(\\d+\\/\\d+\\).*?\\+\\d+`);
const GROK_TURN_STATUS = new RegExp(`${GROK_SPINNER}\\s+\\S.*\\b\\d+(?:\\.\\d+)?s\\b.*\\[stop\\]`);
// cursor-agent (not Grok CLI): mid-turn the composer row shows "ctrl+c to stop"
// on the right of the → prompt, and a status line like "Editing  46.74k tokens"
// sits above it. Idle drops the stop hint and the live token meter. Distinct
// from Grok's "Ctrl+c:cancel" footer pair below.
const CURSOR_STOP_HINT = /ctrl\+c to stop/i;
// Live activity + token meter (e.g. "Reading  48.19k tokens", "Editing  12k tokens").
// Keep this secondary: only match when the stop hint is also present, or when the
// spinner-prefixed status line is clearly the cursor live meter (not a transcript).
const CURSOR_TOKEN_METER = /\b(?:Reading|Editing|Thinking|Generating|Planning|Searching|Running|Working)\b\s+[\d.]+k?\s+tokens?\b/i;
export function isBusy(pane: string): boolean {
  return (
    BUSY_METER.test(pane) ||
    /esc to interrupt/i.test(pane) ||
    GROK_QUEUED_WORK.test(pane) ||
    GROK_TURN_STATUS.test(pane) ||
    (/\b(Thinking|Running|Working|Calling|Executing)\b/i.test(pane) && /\bHermes\b/i.test(pane)) ||
    (/Ctrl\+c:cancel/i.test(pane) && /Ctrl\+Enter:interject/i.test(pane)) ||
    // cursor-agent: "ctrl+c to stop" is the stable mid-turn interrupt hint.
    CURSOR_STOP_HINT.test(pane) ||
    // Fallback if the stop hint is briefly absent while the token meter is up.
    CURSOR_TOKEN_METER.test(pane)
  );
}

// Claude Code occasionally floats a session-rating overlay just above the
// composer: a single line like "  1: Bad   2: Fine   3: Good   0: Dismiss".
// It captures Enter and number keys, but it renders as `N: label` (colon, all
// on one line) — NOT the `❯ N. label` newline-separated shape parsePrompt
// matches — so the send queue can't see it. A send then types into the
// composer fine but the Enter is swallowed by the overlay, stranding the
// message ("never left the input box after retries"). Match the distinctive
// options line directly so the sender can dismiss it first.
export function feedbackPromptOpen(pane: string): boolean {
  return pane
    .split("\n")
    .some((l) => /\b0:\s*Dismiss\b/.test(l) && /\b(Bad|Fine|Good)\b/.test(l));
}

// Dismiss the rating overlay by selecting its "0: Dismiss" option (a single
// keystroke, no Enter). Harmless — the rating is optional — and it returns
// keyboard focus to the composer so the queued message can submit.
export function tmuxDismissFeedback(target: string): void {
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", "0"]);
}

// Answer an active selector by arrowing the cursor to the target option, then
// Enter. Arrow nav is reliable in this modal state where literal text is not.
export async function answerPrompt(
  target: string,
  index: number,
): Promise<{ ok: boolean; error?: string }> {
  const pane = capturePane(target);
  const p = pane ? parsePrompt(pane) : null;
  if (!p) {
    // The pane parser couldn't read a selector, but an AskUserQuestion with an
    // option preview (or a multi-select/wrapped layout) still has one open — it
    // just renders a side-by-side box the scraper can't follow, and the prompt
    // was surfaced from the transcript instead (see pendingToolPrompt). Answer
    // it by pressing the option's number directly: single-key selection doesn't
    // need to know the current cursor position, so it works where arrow-nav
    // (which depends on parsing the cursor) can't. 1–9 only — every real
    // AskUserQuestion has ≤4 options.
    if (pane && questionSelectorOpen(pane) && index >= 1 && index <= 9) {
      Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", String(index)]);
      await Bun.sleep(120);
      const r = Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
      if (r.exitCode !== 0)
        return { ok: false, error: new TextDecoder().decode(r.stderr) || "Enter failed" };
      return { ok: true };
    }
    return { ok: false, error: "no active prompt in pane" };
  }
  if (/^Run this command\?$/i.test(p.question)) {
    let key: string | null = null;
    if (index === 0) key = "y";
    else if (index === 1) key = "Tab";
    else if (index === 2) key = "BTab";
    else if (index === 3) key = "n";
    if (!key) return { ok: false, error: "option not found" };
    const r = key.length === 1
      ? Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", key])
      : Bun.spawnSync(["tmux", "send-keys", "-t", target, key]);
    if (r.exitCode !== 0)
      return { ok: false, error: new TextDecoder().decode(r.stderr) || "answer failed" };
    return { ok: true };
  }
  const order = p.options.map((o) => o.index);
  const cur = p.options.find((o) => o.selected)?.index ?? order[0];
  const ci = order.indexOf(cur);
  const ti = order.indexOf(index);
  if (ti < 0) return { ok: false, error: "option not found" };
  const delta = ti - ci;
  const key = delta > 0 ? "Down" : "Up";
  for (let i = 0; i < Math.abs(delta); i++) {
    Bun.spawnSync(["tmux", "send-keys", "-t", target, key]);
    await Bun.sleep(60);
  }
  await Bun.sleep(120);
  const r = Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
  if (r.exitCode !== 0)
    return { ok: false, error: new TextDecoder().decode(r.stderr) || "Enter failed" };
  return { ok: true };
}

// Dismiss an open interactive selector (AskUserQuestion / permission / plan) by
// sending Escape — Claude cancels the selector and returns to the composer (for
// AskUserQuestion it records that the user declined to answer). Guarded on a live
// prompt so a stray call can't interrupt a running turn or, on an idle composer,
// trip the second-Escape rewind-history overlay.
//
// A *single* Escape is unreliable: the TUI's input parser can't tell a lone ESC
// from the start of an escape sequence (arrow keys arrive as `ESC [ A`), so the
// byte can sit buffered until the next keystroke flushes it — one send-keys then
// silently does nothing (the observed "X button doesn't dismiss" bug). So we
// re-send, re-checking the pane each round and stopping the instant the selector
// clears. Because we only fire again while the prompt is STILL up, we never land
// a second Escape on the composer (which would open the rewind-history overlay).
export async function dismissPrompt(
  target: string,
): Promise<{ ok: boolean; error?: string }> {
  let pane = capturePane(target);
  if (!pane || !parsePrompt(pane)) return { ok: false, error: "no active prompt in pane" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = Bun.spawnSync(["tmux", "send-keys", "-t", target, "Escape"]);
    if (r.exitCode !== 0)
      return { ok: false, error: new TextDecoder().decode(r.stderr) || "Escape failed" };
    // Poll a few times before re-sending: the parser may register the lone ESC
    // on its own disambiguation timeout, in which case one Escape is enough and
    // we avoid leaving a stray buffered keystroke behind.
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(150);
      pane = capturePane(target);
      if (!pane || !parsePrompt(pane)) return { ok: true };
    }
  }
  return { ok: false, error: "prompt did not dismiss after repeated Escape" };
}

// ---- low-level keystroke primitives for the confirmed-send queue (sendq.ts).
// Blind text+sleep+Enter loses messages (the fixed sleep races a busy TUI, a
// dropped Enter leaves text stranded in the box). sendq drives these and reads
// `inputBoxText` back to confirm each step landed.

export function tmuxType(target: string, text: string): boolean {
  return Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", text]).exitCode === 0;
}

export function tmuxEnter(target: string): boolean {
  return Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]).exitCode === 0;
}

// Wipe the composer before a (re)type so we never fuse our message onto a
// stranded draft. C-u alone (kill-to-start) usually does it, but it's been
// observed to get swallowed once on a freshly-idle pane, leaving the draft —
// and then tmuxType appends, submitting a garbled concatenation. Belt-and-
// suspenders: C-u (kill before cursor) + C-a (jump to start) + C-k (kill after)
// guarantees an empty line regardless of cursor position or a single dropped
// key. All three are harmless no-ops on an already-empty box.
export function tmuxClearInput(target: string): void {
  Bun.spawnSync(["tmux", "send-keys", "-t", target, "C-u", "C-a", "C-k"]);
}

// A single Escape interrupts Claude's current turn (stops generation / aborts
// the running tool). One press only — a second Esc opens the rewind history.
export function tmuxInterrupt(target: string): boolean {
  return Bun.spawnSync(["tmux", "send-keys", "-t", target, "Escape"]).exitCode === 0;
}

// The Claude Code composer renders as the bottom-most pair of `─` rule lines
// with the input (a `❯`-prefixed line, possibly wrapped) between them. We return
// that region verbatim; callers normalize + substring-match their own text, so
// placeholder/ghost hint text in an empty box doesn't matter. Returns null when
// no composer box is visible (e.g. a modal/selector is up instead).
//
// A *named* session draws its name centered in the top border
// (`──── my-session ──`), so a rule line isn't always pure dashes — it just
// starts and ends with a run of them. Matching only `^─{3,}\s*$` missed that
// border, so the composer went undetected and every send to a named session
// typed-then-cleared in a retry loop. Allow an embedded label between the
// leading and trailing dash runs.
const RULE_RE = /^─{3,}.*─\s*$/;

function grokInputBoxText(lines: string[]): string | null {
  for (let bottom = lines.length - 1; bottom >= 0; bottom--) {
    if (!/^\s*╰.*╯\s*$/.test(lines[bottom])) continue;

    for (let top = bottom - 1; top >= 0; top--) {
      if (!/^\s*╭.*╮\s*$/.test(lines[top])) continue;

      const content = lines.slice(top + 1, bottom);
      if (!content.length) break;
      const inner = content.map((line) => {
        const m = line.match(/^\s*│(.*)│\s*$/);
        return m ? (m[1] ?? "").replace(/\s+$/, "") : "";
      });
      if (!inner[0]?.trimStart().startsWith("❯")) break;
      inner[0] = inner[0].replace(/^\s*❯\s?/, "");
      return inner.join("\n");
    }
  }
  return null;
}

export function inputBoxText(target: string): string | null {
  const pane = capturePane(target);
  if (pane == null) return null;
  const lines = pane.split("\n");
  let bottom = -1;
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE_RE.test(lines[i])) {
      if (bottom < 0) bottom = i;
      else {
        top = i;
        break;
      }
    }
  }
  if (bottom >= 0 && top >= 0) return lines.slice(top + 1, bottom).join("\n");

  const grokBox = grokInputBoxText(lines);
  if (grokBox != null) return grokBox;

  // Codex renders the composer as a `›`-prefixed prompt line at the bottom.
  // A multi-line draft (explicit newlines or wrap) continues on the following
  // lines WITHOUT the `›` prefix, then a blank line separates the draft from
  // the status footer — so collect continuation lines up to that blank line.
  // Returning only the `›` line made every multi-line send look "never typed"
  // and the queue clear-retype-fail'd it. Ignore numbered selector rows
  // (`› 1. ...`) so open prompts don't look like an editable composer.
  //
  // This branch must run BEFORE the generic Hermes `>`-prompt fallback below:
  // that regex matches any transcript line starting with `>` (quotes, diffs,
  // shell output), which would hijack composer detection in a codex pane.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*›\s*(.*?)\s*$/);
    if (!m) continue;
    const text = m[1] ?? "";
    if (/^\d+\.\s+/.test(text)) return null;
    const parts = [text];
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) break; // blank line = end of draft, footer follows
      parts.push(lines[j].trim());
    }
    return parts.join("\n");
  }

  // cursor-agent renders the composer as a single bottom line prefixed with a
  // right-arrow (U+2192), e.g. `→ message text`, or `→ Add a follow-up` when
  // empty (the placeholder just won't match the caller's needle). Without this
  // branch inputBoxText returns null for cursor, boxHasNeedle reads "composer
  // not visible", and every send retries type-then-clear and fails with
  // "message never left the input box after retries". Scan bottom-up (the two
  // status lines below the composer don't start with →) and skip numbered
  // selector rows the same way the codex branch does.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*→\s*(.*?)\s*$/);
    if (!m) continue;
    const text = m[1] ?? "";
    if (/^\d+\.\s+/.test(text)) return null;
    return text;
  }

  // Hermes' classic CLI is prompt_toolkit-based and commonly renders a simple
  // bottom prompt rather than a boxed composer. Keep this fallback LAST: `>`
  // also matches quoted/diff lines in other agents' transcripts.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(?:You|User|Human|>>>|❯|>)\s*:?\s*(.*?)\s*$/i);
    if (!m) continue;
    const text = m[1] ?? "";
    if (/^\d+\.\s+/.test(text)) return null;
    return text;
  }

  // cursor-agent renders the composer as a single bottom line prefixed with a
  // right-arrow (U+2192), e.g. `→ message text`, or `→ Add a follow-up` when
  // empty (the placeholder just won't match the caller's needle). Without this
  // branch inputBoxText returns null for cursor, boxHasNeedle reads "composer
  // not visible", and every send retries type-then-clear and fails with
  // "message never left the input box after retries". Scan bottom-up (the two
  // status lines below the composer don't start with →) and skip numbered
  // selector rows the same way the codex branch does.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*→\s*(.*?)\s*$/);
    if (!m) continue;
    const text = m[1] ?? "";
    if (/^\d+\.\s+/.test(text)) return null;
    return text;
  }
  return null;
}
