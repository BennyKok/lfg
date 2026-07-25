// `lfg agents auto …` — the full auto-agent lifecycle from the terminal.
//
// The web UI has had two things the CLI didn't: AUTO CREATION (type one
// freeform sentence, an LLM pass derives the name, cron schedule and the
// sharpened watch instruction) and the LIFECYCLE around an agent once it
// exists (list, show, edit, enable/disable, run now, delete, and the findings
// those runs produce). This module brings both to the CLI over exactly the same
// store + compose code the HTTP API calls, so the two surfaces can't drift.
//
// Writes go straight to the JSON store (data/auto/agents.json) — the scheduler
// inside `lfg serve` re-reads it every tick, so a CLI edit takes effect without
// a restart. The one thing we deliberately delegate is `run`: if serve is up we
// POST to it so the run shows as in-flight in the UI and only one process is
// appending to findings.jsonl. With no serve running we execute in-process.

import { resolve } from "node:path";
import {
  AUTO_AGENT_BACKENDS,
  MODEL_OPTIONS,
  modelsForAgent,
  thinkingLevelsForAgent,
} from "../agent-catalog.ts";
import { cronMatches } from "../auto/scheduler.ts";
import {
  deleteAutoAgent,
  getAutoAgent,
  listAutoAgents,
  listFindings,
  saveAutoAgent,
  updateFinding,
  type AutoAgent,
  type AutoAgentBackend as StoredBackend,
  type Finding,
  type FindingStatus,
} from "../auto/store.ts";
import { getGlobalSettings } from "../settings.ts";

export const AUTO_HELP = `lfg agents auto — create and manage scheduled auto agents

Create:
  lfg agents auto new "<what to watch>"     Compose a whole agent from one sentence
  lfg agents auto enhance "<rough idea>"    Print the sharpened watch instruction
  lfg agents auto create --name N ...       Create explicitly (name/prompt/schedule)

Lifecycle:
  lfg agents auto list [--json]             List auto agents (schedule, next run)
  lfg agents auto show <id> [--json]        Show one agent, prompt included
  lfg agents auto edit <id> [flags]         Change any field
  lfg agents auto enable|disable <id>       Flip the schedule on/off
  lfg agents auto run <id> [--local]        Run now (via serve when it's up)
  lfg agents auto rm <id>                   Delete it

Findings:
  lfg agents auto findings [--status open]  List findings (--agent, --limit, --json)
  lfg agents auto dismiss <findingId>       Dismiss (feeds back: stops resurfacing)
  lfg agents auto read <findingId>          Mark read

Common flags:
  --cwd PATH            Base repo the agent runs in (default: cwd, --no-repo to skip)
  --schedule "0 9 * * *"  5-field cron, evaluated in your configured timezone
  --backend ${AUTO_AGENT_BACKENDS.join("|")}
  --model MODEL         --thinking-level LEVEL   --tool NAME[,NAME]
  --disabled            Create/edit it switched off
  --json                Machine-readable output

Examples:
  lfg agents auto new "watch our deps for CVEs and tell me only if one hits us"
  lfg agents auto new "flag flaky tests" --schedule "0 */4 * * *" --backend codex-aisdk
  lfg agents auto edit dep-cve-watch --schedule "0 8 * * 1-5" --enable
  lfg agents auto findings --status open --json`;

// ---------- flag parsing ----------

export function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) => flags.includes(a));
}

export function option(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const prefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1] !== undefined) return args[idx + 1];
  }
  return undefined;
}

export function options(args: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    else if (arg === name && args[i + 1]) values.push(args[++i]);
  }
  return values;
}

// Switches that take no value. Without this list `--json dep-watch` would eat
// the id as if it were the flag's argument.
const BOOLEAN_FLAGS = new Set([
  "--json",
  "--quiet",
  "--local",
  "--disabled",
  "--enabled",
  "--enable",
  "--disable",
  "--dry",
  "--dry-run",
  "--no-repo",
  "--no-cwd",
  "--force",
  "--help",
]);

// The first non-flag argument, skipping any value consumed by a `--flag value`
// pair. Lets `auto new "<idea>" --schedule "0 9 * * *"` read positionally
// without a full parser.
export function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (
        !arg.includes("=") &&
        !BOOLEAN_FLAGS.has(arg) &&
        args[i + 1] !== undefined &&
        !args[i + 1].startsWith("--")
      ) {
        i++;
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------- shared validation (mirrors POST /api/auto/agents) ----------

export type BackendSelection = {
  // Widened past the catalog's selectable list because a stored agent may sit
  // on a backend the picker no longer offers (e.g. "hermes"); we pass such a
  // value through untouched rather than failing an unrelated edit.
  backend: StoredBackend;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
};

// Validate --backend/--model/--thinking-level/--tool exactly the way the HTTP
// route does, so a CLI-created agent can never be one the UI would reject.
// `fallbackBackend` keeps `edit` on the agent's existing backend when the flag
// is absent.
export function parseBackendSelection(
  args: string[],
  fallbackBackend?: StoredBackend,
): BackendSelection {
  const flag = option(args, "--backend", "--agent")?.trim();
  if (flag && !(AUTO_AGENT_BACKENDS as readonly string[]).includes(flag)) {
    fail(`unknown backend "${flag}" (expected one of ${AUTO_AGENT_BACKENDS.join(", ")})`);
  }
  const backend = (flag ?? fallbackBackend ?? "aisdk") as StoredBackend;

  const model = option(args, "--model")?.trim();
  if (model) {
    if (backend === "aisdk" || backend === "grok") {
      const allowed = modelsForAgent(backend);
      if (!allowed.includes(model)) {
        fail(`unknown ${backend} model "${model}" (expected one of ${allowed.join(", ")})`);
      }
    } else if (!/^[A-Za-z0-9_.:\/-]{1,120}$/.test(model)) {
      fail(`invalid ${backend} model name "${model}"`);
    }
  }

  const thinkingLevel = option(args, "--thinking-level")?.trim();
  if (thinkingLevel) {
    const allowed = thinkingLevelsForAgent(backend);
    if (!allowed) fail(`thinking levels are not supported for ${backend} auto agents`);
    if (!allowed.includes(thinkingLevel)) {
      fail(`unknown thinking level "${thinkingLevel}" for ${backend} (expected one of ${allowed.join(", ")})`);
    }
  }

  const tools = options(args, "--tool").flatMap((value) =>
    value.split(",").map((tool) => tool.trim()).filter(Boolean),
  );

  return { backend, model, thinkingLevel, tools: tools.length ? tools : undefined };
}

export function defaultModelFor(backend: StoredBackend): string | undefined {
  return MODEL_OPTIONS[backend as keyof typeof MODEL_OPTIONS]?.defaultModel;
}

// The base repo the agent runs in. Unlike the web form (a repo picker) the CLI
// already has a meaningful default: the directory you're standing in. --no-repo
// opts out, which for `new`/`enhance` also means a repo-blind, tool-less
// generation pass.
export function resolveCwd(args: string[], fallback?: string): string | undefined {
  if (hasFlag(args, "--no-repo", "--no-cwd")) return undefined;
  const explicit = option(args, "--cwd", "--repo-path");
  if (explicit?.trim()) return resolve(explicit.trim());
  return fallback;
}

// ---------- formatting ----------

const SEVERITY_LABEL: Record<string, string> = { high: "HIGH", med: "MED ", low: "LOW " };

function relTime(ts: number | undefined): string {
  if (!ts) return "never";
  const delta = Date.now() - ts;
  if (delta < 0) return "in the future";
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Next scheduled fire, found by walking forward a minute at a time (the same
// matcher the scheduler ticks with, so this can never disagree with it). Capped
// at 8 days — anything rarer just reports "—".
export function nextRunAt(schedule: string, tz: string, from = new Date()): number | null {
  const base = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 8; i++) {
    const t = base + i * 60_000;
    if (cronMatches(schedule, new Date(t), tz)) return t;
  }
  return null;
}

function formatNext(agent: AutoAgent, tz: string): string {
  // A disabled agent has no next fire; the enabled/OFF column already says why.
  if (!agent.enabled) return "—";
  if (!agent.schedule) return "no schedule";
  const next = nextRunAt(agent.schedule, tz);
  if (next === null) return "—";
  return new Date(next).toLocaleString("en-US", { timeZone: tz, hour12: false });
}

function backendLabel(agent: AutoAgent): string {
  const backend = agent.agent ?? "aisdk";
  return agent.model ? `${backend}/${agent.model}` : backend;
}

// ---------- entry point ----------

export async function cmdAutoAgents(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "new":
    case "compose":
      return autoNew(rest);
    case "enhance":
      return autoEnhance(rest);
    case "create":
      return autoCreate(rest);
    case "list":
    case "ls":
      return autoList(rest);
    case "show":
    case "get":
      return autoShow(rest);
    case "edit":
    case "update":
      return autoEdit(rest);
    case "enable":
      return autoToggle(rest, true);
    case "disable":
    case "pause":
      return autoToggle(rest, false);
    case "run":
      return autoRun(rest);
    case "rm":
    case "delete":
    case "remove":
      return autoRemove(rest);
    case "findings":
      return autoFindings(rest);
    case "dismiss":
      return autoSetFindingStatus(rest, "dismissed");
    case "read":
      return autoSetFindingStatus(rest, "read");
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(AUTO_HELP);
      return;
    default:
      console.error(`Unknown "lfg agents auto" subcommand: ${sub}\n`);
      console.log(AUTO_HELP);
      process.exit(1);
  }
}

// ---------- create ----------

// Auto creation: one sentence in, a saved agent out. Same composer the web
// single-box create uses, so the name/schedule/prompt a CLI user gets are the
// ones the UI would have produced — with explicit flags able to override any of
// the three afterward, and --dry to inspect the draft without saving.
async function autoNew(args: string[]): Promise<void> {
  if (hasFlag(args, "--help", "-h")) {
    console.log(`lfg agents auto new — compose a complete auto agent from one sentence

Usage:
  lfg agents auto new "<what the agent should watch>" [flags]

Flags:
  --name NAME              Override the composed name
  --schedule "0 9 * * *"   Override the composed cron schedule
  --cwd PATH               Base repo to ground the prompt in (default: current dir)
  --no-repo                Compose without inspecting any repo
  --backend ${AUTO_AGENT_BACKENDS.join("|")}
  --model MODEL            --thinking-level LEVEL   --tool NAME[,NAME]
  --disabled               Save it switched off
  --dry                    Print the draft, don't save
  --quiet                  Hide the composer's progress logs
  --json`);
    return;
  }
  const idea = positional(args)?.trim() || option(args, "--prompt")?.trim();
  if (!idea) fail('Usage: lfg agents auto new "<what the agent should watch>"');

  const cwd = resolveCwd(args, process.cwd());
  const quiet = hasFlag(args, "--quiet", "--json");
  const log = (line: string) => {
    if (!quiet) console.error(line);
  };

  if (!quiet) {
    console.error(
      `composing auto agent${cwd ? ` (inspecting ${cwd})` : " (no repo — text only)"}…`,
    );
  }
  const { composeAutoAgent } = await import("../auto/enhance.ts");
  const draft = await composeAutoAgent(idea!, cwd, log).catch((e: unknown) => {
    fail(`compose failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  const name = option(args, "--name")?.trim() || draft.name;
  const schedule = option(args, "--schedule")?.trim() || draft.schedule;
  const selection = parseBackendSelection(args);

  if (hasFlag(args, "--dry", "--dry-run")) {
    const preview = { name, schedule, cwd, prompt: draft.prompt, ...selection };
    if (hasFlag(args, "--json")) console.log(JSON.stringify({ draft: preview }, null, 2));
    else {
      console.log(`name:     ${name}`);
      console.log(`schedule: ${schedule}`);
      console.log(`cwd:      ${cwd ?? "(none)"}`);
      console.log(`backend:  ${selection.backend}${selection.model ? `/${selection.model}` : ""}`);
      console.log(`---\n${draft.prompt}`);
    }
    return;
  }

  const agent = await saveAutoAgent({
    name,
    prompt: draft.prompt,
    schedule,
    enabled: !hasFlag(args, "--disabled"),
    cwd,
    agent: selection.backend,
    model: selection.model || defaultModelFor(selection.backend),
    thinkingLevel: selection.thinkingLevel,
    tools: selection.tools,
  });
  await printSaved(agent, args, "created");
}

// Just the prompt-sharpening half of compose — useful for piping into
// `auto create --prompt-file` or for editing before committing to an agent.
async function autoEnhance(args: string[]): Promise<void> {
  const promptFile = option(args, "--prompt-file");
  const idea = promptFile
    ? (await Bun.file(promptFile).text()).trim()
    : positional(args)?.trim() || option(args, "--prompt")?.trim();
  if (!idea) fail('Usage: lfg agents auto enhance "<rough idea>" [--cwd PATH]');

  const cwd = resolveCwd(args, process.cwd());
  const quiet = hasFlag(args, "--quiet", "--json");
  const { enhanceAutoPrompt } = await import("../auto/enhance.ts");
  const prompt = await enhanceAutoPrompt(
    idea!,
    option(args, "--name"),
    cwd,
    (line) => {
      if (!quiet) console.error(line);
    },
  ).catch((e: unknown) => {
    fail(`enhance failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (hasFlag(args, "--json")) console.log(JSON.stringify({ prompt }, null, 2));
  else console.log(prompt);
}

// Explicit create — the pre-existing `lfg agents create-auto`, kept verbatim in
// behavior and now also reachable as `lfg agents auto create`.
export async function autoCreate(args: string[]): Promise<void> {
  if (hasFlag(args, "--help", "-h")) {
    console.log(`lfg agents auto create — create a scheduled auto agent explicitly

Usage:
  lfg agents auto create --name NAME --prompt-file prompt.md --schedule "0 9 * * *"
  lfg agents auto create --name NAME --prompt "..." --schedule "*/30 * * * *" --backend codex-aisdk --model gpt-5.5

Options:
  --backend ${AUTO_AGENT_BACKENDS.join("|")}
  --model MODEL
  --thinking-level LEVEL
  --cwd PATH | --no-repo
  --tool NAME[,NAME]
  --disabled
  --json

Prefer 'lfg agents auto new "<idea>"' to have the name, schedule and prompt composed for you.`);
    return;
  }
  const name = option(args, "--name")?.trim();
  const schedule = option(args, "--schedule")?.trim();
  const promptInline = option(args, "--prompt");
  const promptFile = option(args, "--prompt-file");
  if (!name || !schedule || (!promptInline && !promptFile)) {
    fail("Usage: lfg agents auto create --name NAME --prompt|--prompt-file TEXT --schedule CRON");
  }
  const prompt = (promptFile ? await Bun.file(promptFile).text() : promptInline ?? "").trim();
  if (!prompt) fail("auto agent prompt is empty");

  const selection = parseBackendSelection(args);
  const agent = await saveAutoAgent({
    name: name!,
    prompt,
    schedule: schedule!,
    enabled: !hasFlag(args, "--disabled"),
    // No implicit cwd here: the explicit path stays explicit (matches the old
    // create-auto behavior, where an unset --cwd meant "unset").
    cwd: resolveCwd(args),
    agent: selection.backend,
    model: selection.model || defaultModelFor(selection.backend),
    thinkingLevel: selection.thinkingLevel,
    tools: selection.tools,
  });
  await printSaved(agent, args, "created");
}

async function printSaved(agent: AutoAgent, args: string[], verb: string): Promise<void> {
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }
  const tz = (await getGlobalSettings()).timeZone;
  console.log(`${verb} auto agent ${agent.id} (${backendLabel(agent)})`);
  console.log(`  schedule: ${agent.schedule}  next: ${formatNext(agent, tz)}`);
  if (agent.cwd) console.log(`  cwd:      ${agent.cwd}`);
  if (!agent.enabled) console.log("  status:   disabled");
  console.log(`  run now:  lfg agents auto run ${agent.id}`);
}

// ---------- lifecycle ----------

async function requireAgent(id: string | undefined, usage: string): Promise<AutoAgent> {
  if (!id) fail(usage);
  const agent = await getAutoAgent(id!);
  if (agent) return agent;
  // Accept a unique prefix, the way session ids work elsewhere in LFG.
  const matches = (await listAutoAgents()).filter((a) => a.id.startsWith(id!));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(`ambiguous auto agent "${id}" (matches ${matches.map((a) => a.id).join(", ")})`);
  }
  return fail(`unknown auto agent "${id}" — see: lfg agents auto list`);
}

async function autoList(args: string[]): Promise<void> {
  const agents = await listAutoAgents();
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ agents }, null, 2));
    return;
  }
  if (!agents.length) {
    console.log('(no auto agents yet — create one with: lfg agents auto new "<what to watch>")');
    return;
  }
  const tz = (await getGlobalSettings()).timeZone;
  const findings = await listFindings("open");
  for (const agent of agents) {
    const open = findings.filter((f) => f.agentId === agent.id).length;
    console.log(
      `${agent.enabled ? "on " : "OFF"} ${agent.id.padEnd(24)} ${agent.schedule.padEnd(16)} ${backendLabel(agent).padEnd(24)} last ${relTime(agent.lastRunAt).padEnd(10)} next ${formatNext(agent, tz)}${open ? `  (${open} open)` : ""}`,
    );
  }
  console.log(`\ntimezone: ${tz}`);
}

async function autoShow(args: string[]): Promise<void> {
  const agent = await requireAgent(positional(args), "Usage: lfg agents auto show <id>");
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }
  const tz = (await getGlobalSettings()).timeZone;
  const mine = (await listFindings()).filter((f) => f.agentId === agent.id);
  console.log(`${agent.id} — ${agent.name}`);
  console.log(`  status:   ${agent.enabled ? "enabled" : "disabled"}`);
  console.log(`  schedule: ${agent.schedule} (${tz})  next: ${formatNext(agent, tz)}`);
  console.log(`  last run: ${relTime(agent.lastRunAt)}`);
  console.log(`  backend:  ${backendLabel(agent)}${agent.thinkingLevel ? ` thinking:${agent.thinkingLevel}` : ""}`);
  console.log(`  cwd:      ${agent.cwd ?? "(unset — defaults to the lfg repo)"}`);
  if (agent.tools?.length) console.log(`  tools:    ${agent.tools.join(", ")}`);
  console.log(`  findings: ${mine.filter((f) => f.status === "open").length} open / ${mine.length} total`);
  console.log(`\n${agent.prompt}`);
}

async function autoEdit(args: string[]): Promise<void> {
  const agent = await requireAgent(positional(args), "Usage: lfg agents auto edit <id> [flags]");
  const promptFile = option(args, "--prompt-file");
  const prompt = promptFile
    ? (await Bun.file(promptFile).text()).trim()
    : option(args, "--prompt")?.trim();
  const selection = parseBackendSelection(args, agent.agent);

  const enabled = hasFlag(args, "--enable", "--enabled")
    ? true
    : hasFlag(args, "--disable", "--disabled")
      ? false
      : agent.enabled;

  const saved = await saveAutoAgent({
    id: agent.id,
    name: option(args, "--name")?.trim() || agent.name,
    prompt: prompt || agent.prompt,
    schedule: option(args, "--schedule")?.trim() || agent.schedule,
    enabled,
    cwd: resolveCwd(args) ?? agent.cwd,
    agent: selection.backend,
    // An explicit --backend with no --model would otherwise keep the previous
    // backend's model, which the new backend may not know. Fall back to the new
    // backend's default in that case.
    model:
      selection.model ??
      (selection.backend === (agent.agent ?? "aisdk")
        ? agent.model
        : defaultModelFor(selection.backend)),
    thinkingLevel: selection.thinkingLevel ?? agent.thinkingLevel,
    tools: selection.tools ?? agent.tools,
  });
  await printSaved(saved, args, "updated");
}

async function autoToggle(args: string[], enabled: boolean): Promise<void> {
  const agent = await requireAgent(
    positional(args),
    `Usage: lfg agents auto ${enabled ? "enable" : "disable"} <id>`,
  );
  const saved = await saveAutoAgent({
    id: agent.id,
    name: agent.name,
    prompt: agent.prompt,
    schedule: agent.schedule,
    enabled,
    cwd: agent.cwd,
    agent: agent.agent,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    tools: agent.tools,
  });
  await printSaved(saved, args, enabled ? "enabled" : "disabled");
}

async function autoRemove(args: string[]): Promise<void> {
  const agent = await requireAgent(positional(args), "Usage: lfg agents auto rm <id>");
  await deleteAutoAgent(agent.id);
  if (hasFlag(args, "--json")) console.log(JSON.stringify({ ok: true, id: agent.id }, null, 2));
  else console.log(`deleted auto agent ${agent.id}`);
}

// ---------- run ----------

const servePort = () => Number(process.env.LFG_PORT ?? process.env.PORT ?? 8766);

// Hand the run to a live `lfg serve` when there is one: it owns the in-flight
// marker the UI renders and is the only writer of findings.jsonl, so we avoid
// two processes doing a read-modify-write on the same file. Returns false when
// serve isn't reachable and we should run in-process instead.
async function dispatchToServe(id: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${servePort()}/api/auto/agents/${id}/run`, {
      method: "POST",
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function autoRun(args: string[]): Promise<void> {
  const agent = await requireAgent(positional(args), "Usage: lfg agents auto run <id>");
  const json = hasFlag(args, "--json");

  if (!hasFlag(args, "--local")) {
    if (await dispatchToServe(agent.id)) {
      if (json) console.log(JSON.stringify({ dispatched: "serve", id: agent.id }, null, 2));
      else {
        console.log(`dispatched ${agent.id} to lfg serve — watch it with:`);
        console.log(`  lfg agents auto findings --agent ${agent.id}`);
      }
      return;
    }
    if (!json) console.error("lfg serve not reachable — running locally");
  }

  const { runAutoAgent } = await import("../auto/runner.ts");
  const finding = await runAutoAgent(agent, (line) => {
    if (!json) console.error(line);
  });
  if (json) {
    console.log(JSON.stringify({ dispatched: "local", finding }, null, 2));
    return;
  }
  if (!finding) {
    console.log("no finding — the agent surfaced nothing (that's the normal case)");
    return;
  }
  printFinding(finding, agent.name);
}

// ---------- findings ----------

function printFinding(f: Finding, agentName?: string): void {
  console.log(
    `${SEVERITY_LABEL[f.severity] ?? f.severity} ${f.id}  ${f.title}  [${f.status}] ${agentName ?? f.agentId} · ${relTime(f.createdAt)}`,
  );
  for (const line of f.reasoning ?? []) console.log(`      - ${line}`);
  if (f.suggest) console.log(`      → ${f.suggest}`);
}

async function autoFindings(args: string[]): Promise<void> {
  const statusFlag = option(args, "--status")?.trim();
  const status = !statusFlag || statusFlag === "all" ? undefined : statusFlag;
  const agentId = option(args, "--agent")?.trim();
  const limit = Math.max(1, Number(option(args, "--limit") ?? 50) || 50);

  let findings = await listFindings(status);
  if (agentId) findings = findings.filter((f) => f.agentId === agentId || f.agentId.startsWith(agentId));
  findings = findings.slice(0, limit);

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
    return;
  }
  if (!findings.length) {
    console.log(`(no ${status ?? ""} findings${agentId ? ` for ${agentId}` : ""})`);
    return;
  }
  const names = new Map((await listAutoAgents()).map((a) => [a.id, a.name]));
  for (const f of findings) printFinding(f, names.get(f.agentId));
}

// Dismissing is part of the anti-noise loop, not just bookkeeping: the runner
// feeds dismissed titles back into the next prompt so the agent stops
// resurfacing them. Same store call the UI's dismiss button makes.
async function autoSetFindingStatus(args: string[], status: FindingStatus): Promise<void> {
  const id = positional(args);
  if (!id) fail(`Usage: lfg agents auto ${status === "dismissed" ? "dismiss" : "read"} <findingId>`);
  let updated = await updateFinding(id!, { status });
  if (!updated) {
    const matches = (await listFindings()).filter((f) => f.id.startsWith(id!));
    if (matches.length > 1) {
      fail(`ambiguous finding "${id}" (matches ${matches.map((f) => f.id).join(", ")})`);
    }
    if (matches.length === 1) updated = await updateFinding(matches[0].id, { status });
  }
  if (!updated) fail(`unknown finding "${id}" — see: lfg agents auto findings`);
  if (hasFlag(args, "--json")) console.log(JSON.stringify({ finding: updated }, null, 2));
  else console.log(`${updated!.id} → ${status}: ${updated!.title}`);
}
