// Runs one auto agent: build a prompt from the agent's instruction + the
// dismiss-feedback block, pipe it to a real headless Claude session with
// read-only tools, and parse at most ONE finding out of the result. Most runs
// should return null — silence is the default, not a padded report.

import { PATHS } from "../config.ts";
import { notifyAll } from "../push.ts";
import { runInCwd } from "./cwd-lock.ts";
import {
  type AutoAgent,
  type Finding,
  type Severity,
  addFinding,
  clearRunning,
  hasOpenSimilar,
  listFindings,
  markRunning,
} from "./store.ts";

const SYSTEM = `You are an autonomous watch agent. Carry out the instruction below.

You have read-only tools (Read, Grep, Glob, WebSearch, WebFetch) — use them to
gather your own context. Decide whether there is ONE finding worth surfacing as
a notification right now. Be strict: most runs should surface nothing. Only
surface something concrete, high-leverage, and actionable — never filler.

Respond with ONLY a JSON object as the final thing you output. No prose around
it, no markdown fence. One of:

{"finding": null}

or

{"finding": {"title": "<one line>", "severity": "high" | "med" | "low", "reasoning": ["<short bullet>", "..."], "suggest": "<one-line concrete fix>"}}

Rules: title is one line. At most 4 short reasoning bullets. No essay.`;

function normSeverity(s: unknown): Severity {
  const v = String(s ?? "").toLowerCase();
  if (v.startsWith("h")) return "high";
  if (v.startsWith("l")) return "low";
  return "med";
}

function parseFinding(text: string): { finding: unknown } | null {
  const tryParse = (s: string): any => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  let j: any = tryParse(text.trim());
  if (!j) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) j = tryParse(fence[1].trim());
  }
  if (!j) {
    // last balanced-ish object in the text
    const m = text.match(/\{[\s\S]*\}/);
    if (m) j = tryParse(m[0]);
  }
  if (!j || typeof j !== "object") return null;
  if (!("finding" in j)) {
    if ("title" in j) return { finding: j };
    return null;
  }
  return j;
}

const READONLY_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"];

async function runClaude(
  prompt: string,
  cwd: string,
  onLog: (s: string) => void,
  extraTools: string[] = [],
  opts: { model?: string; thinkingLevel?: string } = {},
): Promise<string> {
  const allowedTools = [...READONLY_TOOLS, ...extraTools];
  onLog(`[auto] claude run (${prompt.length} chars) in ${cwd} [model: ${opts.model ?? "default"}; tools: ${allowedTools.join(",")}]`);
  // Route through the AI-SDK report backend instead of spawning `claude -p`
  // directly: it drives the same installed claude binary + subscription auth,
  // but stays on the AI SDK surface (same as the interactive harnesses) and
  // returns the assistant text directly — so we no longer parse the CLI's
  // --output-format json envelope. The agent's read-only toolset is preserved
  // via allowedTools (this also implicitly excludes AskUserQuestion, which a
  // headless run can't answer). cwd is honored because pipeToClaudeAiSdk runs
  // in this process and the auto runner has already chdir'd / the provider
  // inherits the cwd; we pass it through unchanged in behavior.
  const { pipeToClaudeAiSdk } = await import("../agents/backends/claude-ai-sdk.ts");
  try {
    // The provider drives claude in the current working directory; scope it to
    // the agent's cwd for the duration of the run. chdir is process-global, so
    // the whole chdir→run→restore is serialized under the shared cwd lock.
    return await runInCwd(cwd, () =>
      pipeToClaudeAiSdk(prompt, onLog, {
        allowedTools,
        model: opts.model,
        thinkingLevel: opts.thinkingLevel,
      }),
    );
  } catch (e) {
    // The report backend throws on an empty generation; the old `claude -p`
    // path returned the (empty) output and let parseFinding treat it as
    // silence. Preserve that silent-by-default behavior: a run that produced
    // nothing yields "" → no parseable finding → null, not a thrown error.
    if (e instanceof Error && /empty result/i.test(e.message)) {
      onLog("[auto] ai-sdk produced no output — treating as silence");
      return "";
    }
    throw e;
  }
}

async function runSelectedBackend(
  agent: AutoAgent,
  prompt: string,
  cwd: string,
  onLog: (s: string) => void,
): Promise<string> {
  const backend = agent.agent ?? "aisdk";
  if (backend === "codex-aisdk") {
    onLog(`[auto] codex run (${prompt.length} chars) in ${cwd} [model: ${agent.model ?? "default"}]`);
    const { pipeToCodexAiSdk } = await import("../agents/backends/codex-aisdk-session.ts");
    return await runInCwd(cwd, () =>
      pipeToCodexAiSdk(prompt, onLog, {
        cwd,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
      }),
    );
  }
  if (backend === "opencode") {
    onLog(`[auto] opencode run (${prompt.length} chars) in ${cwd} [model: ${agent.model ?? "default"}]`);
    const { pipeToOpencodeAiSdk } = await import("../agents/backends/opencode-aisdk-session.ts");
    return await runInCwd(cwd, () =>
      pipeToOpencodeAiSdk(prompt, onLog, { cwd, model: agent.model }),
    );
  }
  if (backend === "grok") {
    onLog(`[auto] grok run (${prompt.length} chars) in ${cwd} [model: ${agent.model ?? "default"}]`);
    const { pipeToGrokCli } = await import("../agents/backends/grok-cli.ts");
    return await runInCwd(cwd, () =>
      pipeToGrokCli(prompt, onLog, {
        cwd,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        writable: (agent.tools ?? []).includes("Bash"),
      }),
    );
  }
  if (backend === "cursor") {
    onLog(`[auto] cursor run (${prompt.length} chars) in ${cwd} [model: ${agent.model ?? "default"}]`);
    const { pipeToCursorCli } = await import("../agents/backends/cursor-cli.ts");
    return await runInCwd(cwd, () =>
      pipeToCursorCli(prompt, onLog, {
        cwd,
        model: agent.model,
        thinkingLevel: agent.thinkingLevel,
        writable: (agent.tools ?? []).includes("Bash"),
      }),
    );
  }
  if (backend === "hermes") {
    onLog(`[auto] hermes run (${prompt.length} chars) in ${cwd} [model: ${agent.model ?? "default"}]`);
    const { pipeToHermesCli } = await import("../agents/backends/hermes-cli.ts");
    return await runInCwd(cwd, () =>
      pipeToHermesCli(prompt, onLog, { cwd, model: agent.model }),
    );
  }
  return await runClaude(prompt, cwd, onLog, agent.tools ?? [], {
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
  });
}

export async function runAutoAgent(
  agent: AutoAgent,
  onLog: (s: string) => void = () => {},
): Promise<Finding | null> {
  // Mark in-flight synchronously (before the first await) so a manual /run is
  // already "running" by the time the POST returns; always clear when done.
  markRunning(agent.id);
  try {
    return await runAutoAgentInner(agent, onLog);
  } finally {
    clearRunning(agent.id);
  }
}

async function runAutoAgentInner(
  agent: AutoAgent,
  onLog: (s: string) => void = () => {},
): Promise<Finding | null> {
  const mine = (await listFindings()).filter((f) => f.agentId === agent.id);
  const dismissed = mine.filter((f) => f.status === "dismissed").slice(0, 20);
  const open = mine.filter((f) => f.status === "open").slice(0, 20);

  let feedback = "";
  if (dismissed.length) {
    feedback +=
      "\n\n## The human DISMISSED these — do NOT resurface them:\n" +
      dismissed.map((f) => `- ${f.title}`).join("\n");
  }
  if (open.length) {
    feedback +=
      "\n\n## Already open (don't repeat):\n" +
      open.map((f) => `- ${f.title}`).join("\n");
  }

  const prompt = `${SYSTEM}\n\n## Instruction\n${agent.prompt}${feedback}`;
  // The agent's base repo (chosen from the repo list in the UI) is where it runs
  // and from which it inherits .claude/settings.json. If it's unset, fall back to
  // the repo root but say so loudly — a missing base means the agent is watching
  // the wrong tree, which is exactly the silent-misconfig we want surfaced.
  const cwd = agent.cwd ?? PATHS.root;
  if (!agent.cwd) {
    onLog(`[auto] WARNING: agent "${agent.id}" has no base repo (cwd) — defaulting to ${PATHS.root}; set one in the editor`);
  }
  const result = await runSelectedBackend(agent, prompt, cwd, onLog);

  const parsed = parseFinding(result);
  if (!parsed) {
    onLog("[auto] no parseable finding — treating as silence");
    return null;
  }
  if (parsed.finding == null) {
    onLog("[auto] agent surfaced nothing");
    return null;
  }
  const f = parsed.finding as Record<string, unknown>;
  const title = String(f.title ?? "").trim();
  if (!title) {
    onLog("[auto] finding had no title — skipping");
    return null;
  }
  if (await hasOpenSimilar(agent.id, title)) {
    onLog(`[auto] duplicate of an existing finding — skipping: ${title}`);
    return null;
  }
  const finding = await addFinding({
    agentId: agent.id,
    title,
    severity: normSeverity(f.severity),
    reasoning: Array.isArray(f.reasoning)
      ? f.reasoning.map((r) => String(r)).slice(0, 6)
      : [],
    suggest: f.suggest ? String(f.suggest) : undefined,
  });
  onLog(`[auto] new finding: ${title}`);
  // Wake installed PWAs via Web Push. Payload-less: the service worker fetches
  // the finding itself. Best-effort — never let a push failure sink the run.
  void notifyAll().catch(() => {});
  return finding;
}
