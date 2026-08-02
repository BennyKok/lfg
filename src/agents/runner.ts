import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../config.ts";
import { type Agent, loadAgent, listAgents } from "./registry.ts";
import { runCollector } from "./collectors/index.ts";

export type RunOptions = {
  date?: string;
  dryRun?: boolean;
  onLog?: (line: string) => void;
  // Override the report-generation backend for this run. Falls back to
  // LFG_CLAUDE_BACKEND, then "cli". Lets the web UI pick per-run.
  backend?: string;
  // Model for the ai-sdk backend (opus|sonnet|haiku|full id). Ignored by the
  // cli backend, which uses the installed CLI's configured model.
  model?: string;
};

export type RunResult = {
  agent: string;
  date: string;
  reportPath: string;
  actionsPath: string;
  bytes: number;
  ok: boolean;
  collectorWarnings: { kind: string; warning: string }[];
};

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function reportDir(agent: string): string {
  return join(PATHS.data, "reports", agent);
}

export function reportPathFor(agent: string, date: string): string {
  return join(reportDir(agent), `${date}.md`);
}

export function actionsPathFor(agent: string, date: string): string {
  return join(reportDir(agent), `${date}.actions.jsonl`);
}

async function readContextFile(rel: string): Promise<string | null> {
  const p = join(PATHS.root, rel);
  const f = Bun.file(p);
  if (!(await f.exists())) return null;
  return await f.text();
}

// Continuity: feed the agent its own recent action history (what shipped vs.
// what's still pending) so it stops re-proposing finished work and escalates to
// new, bigger findings instead of re-mining the same vein every cold-start day.
async function buildContinuityBlock(
  agent: string,
  currentDate: string,
  maxDays = 7,
  maxActions = 30,
): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(reportDir(agent));
  } catch {
    return null;
  }
  const suffix = ".actions.jsonl";
  const dates = files
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .filter((d) => d < currentDate)
    .sort()
    .reverse()
    .slice(0, maxDays);
  if (dates.length === 0) return null;

  const lines: string[] = [];
  let count = 0;
  for (const d of dates) {
    if (count >= maxActions) break;
    const rows = await readActionsSidecar(agent, d);
    const dayLines: string[] = [];
    for (const r of rows) {
      if (count >= maxActions) break;
      const text = r.text.replace(/\s+/g, " ").trim().slice(0, 160);
      dayLines.push(`- [${r.status}] ${text}`);
      count++;
    }
    if (dayLines.length) {
      lines.push(`### ${d}`);
      lines.push(...dayLines);
    }
  }
  return lines.length ? lines.join("\n") : null;
}

async function buildPrompt(
  agent: Agent,
  date: string,
  log: (s: string) => void,
): Promise<{ prompt: string; warnings: { kind: string; warning: string }[] }> {
  const parts: string[] = [];
  parts.push(`# ${agent.frontmatter.title ?? agent.name} — ${date}`);
  parts.push("");
  parts.push("## Instructions for you (the agent)");
  parts.push("");
  parts.push(agent.body.trim());
  parts.push("");

  let blockIdx = 1;

  const continuity = await buildContinuityBlock(agent.name, date);
  if (continuity) {
    parts.push("---");
    parts.push(`## Block ${blockIdx++} — Your recent runs (continuity)`);
    parts.push("");
    parts.push(
      "Actions you proposed on prior days, each tagged with whether it " +
        "**shipped** (`done`), is still **pending** (never executed), or " +
        "**failed**. Do NOT re-propose shipped work, and don't pile onto the " +
        "pending stack — reference a prior date instead and spend today's slots " +
        "escalating to something new and bigger.",
    );
    parts.push("");
    parts.push(continuity);
    parts.push("");
  }
  for (const rel of agent.frontmatter.context_files ?? []) {
    const text = await readContextFile(rel);
    parts.push("---");
    parts.push(`## Block ${blockIdx++} — Context: ${rel}`);
    parts.push("");
    if (text === null) {
      parts.push(`(context file '${rel}' not found at ${join(PATHS.root, rel)})`);
    } else {
      parts.push(text.trim());
    }
    parts.push("");
  }

  const warnings: { kind: string; warning: string }[] = [];
  const specs = agent.frontmatter.inputs ?? [];
  log(`[runner] collecting ${specs.length} inputs in parallel`);
  const results = await Promise.all(specs.map((s) => runCollector(s)));
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const res = results[i];
    log(`[runner] input[${i}] ${spec.kind} → ${res.ok ? "ok" : "FAIL"}`);
    if (!res.ok && res.warning) warnings.push({ kind: spec.kind, warning: res.warning });
    parts.push("---");
    parts.push(`## Block ${blockIdx++} — ${res.title}`);
    parts.push("");
    parts.push(res.body);
    parts.push("");
  }

  return { prompt: parts.join("\n"), warnings };
}

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Backend dispatch: "ai-sdk" (now the default) routes through the Vercel AI SDK
// agent harness via the claude-code community provider (which drives the same
// installed binary + subscription auth); "cli" spawns `claude -p` directly.
// Default flip (Task B): the fallback is now "ai-sdk" instead of "cli" — set
// LFG_CLAUDE_BACKEND=cli to opt back into the direct-CLI path.
async function pipeToClaude(
  prompt: string,
  log: (s: string) => void,
  backendOverride?: string,
  modelOverride?: string,
): Promise<string> {
  const backend = (
    backendOverride ?? process.env.LFG_CLAUDE_BACKEND ?? "ai-sdk"
  ).toLowerCase();
  if (backend === "ai-sdk" || backend === "ai_sdk" || backend === "aisdk") {
    const { pipeToClaudeAiSdk } = await import("./backends/claude-ai-sdk.ts");
    return pipeToClaudeAiSdk(prompt, log, { model: modelOverride });
  }
  return pipeToClaudeCli(prompt, log);
}

async function pipeToClaudeCli(
  prompt: string,
  log: (s: string) => void,
): Promise<string> {
  log(`[runner] piping ${prompt.length} chars to claude -p`);
  // stream-json + partial messages gives us live progress during the long
  // generation phase instead of ~60-90s of silence. We parse the NDJSON event
  // stream, emit throttled progress, and pull the final text from the `result`.
  const proc = Bun.spawn({
    cmd: [
      "claude", "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      // Headless `-p` denies any tool not pre-approved. Grant the read-only web
      // tools so agents can pull "other sources" (model launches, deprecation
      // notices, benchmarks) — without this, WebSearch/WebFetch are silently
      // denied and the agent falls back to its collector blocks only.
      "--allowedTools", "WebSearch,WebFetch",
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  proc.stdin.write(prompt);
  await proc.stdin.end();

  const decoder = new TextDecoder();
  let buf = "";
  let result: string | null = null;
  let chars = 0;
  let lastEmit = 0;
  const flush = (force = false) => {
    const now = Date.now();
    if (force || now - lastEmit > 800) {
      lastEmit = now;
      log(`[runner] generating report… ${fmtChars(chars)} chars`);
    }
  };

  const handle = (ev: any) => {
    if (ev.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
        chars += (e.delta.text ?? "").length;
        flush();
      } else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
        log(`[runner] claude running tool: ${e.content_block.name}`);
      }
    } else if (ev.type === "system" && ev.subtype === "init") {
      log(`[runner] claude session started`);
    } else if (ev.type === "result") {
      result = typeof ev.result === "string" ? ev.result : "";
      if (ev.is_error || ev.subtype !== "success") {
        throw new Error(`claude result error (${ev.subtype}): ${String(ev.result).slice(0, 800)}`);
      }
      log(`[runner] claude done in ${Math.round((ev.duration_ms ?? 0) / 100) / 10}s`);
    }
  };

  for await (const chunk of proc.stdout as any) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      handle(ev);
    }
  }
  const [err, exit] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`claude -p exited ${exit}: ${err.slice(0, 1000)}`);
  }
  if (result == null) {
    throw new Error("claude -p produced no result event");
  }
  if (err.trim()) log(`[runner] claude stderr: ${err.slice(0, 400)}`);
  flush(true);
  return result;
}

const ACTION_FENCE_RE = /```action\s*\n([\s\S]*?)\n```/g;

export type ParsedAction = {
  id: string;
  idx: number;
  text: string;
};

export function parseActions(agent: string, date: string, report: string): ParsedAction[] {
  const out: ParsedAction[] = [];
  let m: RegExpExecArray | null;
  ACTION_FENCE_RE.lastIndex = 0;
  let idx = 0;
  while ((m = ACTION_FENCE_RE.exec(report))) {
    const text = m[1].trim();
    if (!text) {
      idx++;
      continue;
    }
    const id = createHash("sha256")
      .update(agent + "|" + date + "|" + idx + "|" + text)
      .digest("hex")
      .slice(0, 16);
    out.push({ id, idx, text });
    idx++;
  }
  return out;
}

export type ActionRow = ParsedAction & {
  status: "pending" | "running" | "done" | "failed";
  executedAt?: string;
  result?: { ok: boolean; summary: string; data?: unknown };
  error?: string;
  // When dispatched into its own tmux session, the handle to drive it.
  session?: string;
  sessionId?: string;
};

export async function writeActionsSidecar(
  agent: string,
  date: string,
  actions: ParsedAction[],
) {
  const path = actionsPathFor(agent, date);
  const lines = actions.map((a) =>
    JSON.stringify({ ...a, status: "pending" } as ActionRow),
  );
  await Bun.write(path, lines.join("\n") + (lines.length ? "\n" : ""));
}

export async function readActionsSidecar(
  agent: string,
  date: string,
): Promise<ActionRow[]> {
  const path = actionsPathFor(agent, date);
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  const text = await f.text();
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ActionRow);
}

export async function updateActionRow(
  agent: string,
  date: string,
  id: string,
  patch: Partial<ActionRow>,
): Promise<ActionRow | null> {
  const rows = await readActionsSidecar(agent, date);
  let found: ActionRow | null = null;
  const next = rows.map((r) => {
    if (r.id === id) {
      const merged = { ...r, ...patch };
      found = merged;
      return merged;
    }
    return r;
  });
  if (!found) return null;
  await Bun.write(
    actionsPathFor(agent, date),
    next.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return found;
}

export async function runAgent(
  name: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const date = opts.date ?? todayUtc();
  const log = opts.onLog ?? (() => {});
  const agent = await loadAgent(name);

  if (agent.frontmatter.enabled === false) {
    throw new Error(`agent '${name}' is disabled (frontmatter enabled: false)`);
  }

  await mkdir(reportDir(name), { recursive: true });

  const { prompt, warnings } = await buildPrompt(agent, date, log);

  if (opts.dryRun) {
    const path = join(reportDir(name), `${date}.prompt.md`);
    await Bun.write(path, prompt);
    log(`[runner] dry-run: wrote prompt to ${path}`);
    return {
      agent: name,
      date,
      reportPath: path,
      actionsPath: actionsPathFor(name, date),
      bytes: prompt.length,
      ok: true,
      collectorWarnings: warnings,
    };
  }

  const report = await pipeToClaude(prompt, log, opts.backend, opts.model);
  const rPath = reportPathFor(name, date);
  await Bun.write(rPath, report);
  log(`[runner] wrote ${rPath} (${report.length} bytes)`);

  const actions = parseActions(name, date, report);
  await writeActionsSidecar(name, date, actions);
  log(`[runner] parsed ${actions.length} actions → ${actionsPathFor(name, date)}`);

  return {
    agent: name,
    date,
    reportPath: rPath,
    actionsPath: actionsPathFor(name, date),
    bytes: report.length,
    ok: true,
    collectorWarnings: warnings,
  };
}

export async function runAllAgents(opts: RunOptions = {}): Promise<RunResult[]> {
  const agents = await listAgents();
  const log = opts.onLog ?? (() => {});
  const results: RunResult[] = [];
  for (const a of agents) {
    if (a.frontmatter.enabled === false) {
      log(`[runner] skipping ${a.name} (disabled)`);
      continue;
    }
    log(`[runner] === ${a.name} ===`);
    try {
      results.push(await runAgent(a.name, opts));
    } catch (e) {
      log(`[runner] ${a.name} FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
  return results;
}
