// Auto agents — the streamlined replacement for report-writing agents. An auto
// agent is JUST a prompt + a schedule. It runs as a real Claude session with
// read-only tools and, at most, emits ONE finding (a notification), not a
// report. Findings carry their reasoning and a lifecycle (open → dismissed /
// session). Dismissed findings are fed back into the prompt so the agent stops
// resurfacing the same thing — that's the anti-noise loop.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../config.ts";

export type Severity = "high" | "med" | "low";
export type AutoAgentBackend =
  | "aisdk"
  | "codex-aisdk"
  | "grok"
  | "cursor"
  | "opencode"
  | "hermes";

export type AutoAgent = {
  id: string;
  name: string;
  prompt: string; // the entire agent
  schedule: string; // 5-field cron expression
  enabled: boolean;
  cwd?: string; // where the Claude session runs; defaults to repo root
  agent?: AutoAgentBackend; // omitted for old rows = "aisdk" (Claude AI SDK)
  model?: string;
  thinkingLevel?: string;
  // Extra tools granted to this agent on top of the read-only default set
  // (Read/Grep/Glob/WebSearch/WebFetch). e.g. ["Bash"] for agents that need to
  // shell out to a data bridge. Empty/undefined = read-only.
  tools?: string[];
  lastRunAt?: number;
};

// "resolved" is TERMINAL and is the only status that means the underlying
// problem is actually gone. Everything else — including "session" — only
// records what happened to the *notification*, not to the problem. That gap is
// why a correct, high-severity finding ("sqld WAL is 2.3 GB, checkpoints not
// truncating", 2026-07-12) spawned a session, the session ended, nobody
// re-checked, and the same failure caused a four-day backup outage ten days
// later. A finding is not done because someone looked at it.
export type FindingStatus =
  | "open"
  | "dismissed"
  | "session"
  | "read"
  | "resolved";

// Statuses where the underlying problem may still be live. Recurrence is
// measured against these — NOT against "open"/"dismissed" alone, which was the
// original bug: 302 of 396 findings sat in "session", so a repeat report never
// matched and was filed as brand new instead of escalating.
const UNRESOLVED: FindingStatus[] = ["open", "dismissed", "session", "read"];

export type Finding = {
  id: string;
  agentId: string;
  title: string;
  reasoning: string[];
  suggest?: string;
  severity: Severity;
  createdAt: number;
  status: FindingStatus;
  sessionId?: string;
  /** How many times an agent has independently reported this. 1 on first sight. */
  occurrences?: number;
  /** When it was most recently re-observed (differs from createdAt once it recurs). */
  lastSeenAt?: number;
};

const dir = () => join(PATHS.data, "auto");
const agentsPath = () => join(dir(), "agents.json");
const findingsPath = () => join(dir(), "findings.jsonl");

async function ensure() {
  await mkdir(dir(), { recursive: true });
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

// ---------- agents ----------

export async function listAutoAgents(): Promise<AutoAgent[]> {
  const f = Bun.file(agentsPath());
  if (!(await f.exists())) return [];
  try {
    return JSON.parse(await f.text()) as AutoAgent[];
  } catch {
    return [];
  }
}

export async function getAutoAgent(id: string): Promise<AutoAgent | null> {
  return (await listAutoAgents()).find((a) => a.id === id) ?? null;
}

export async function saveAutoAgent(input: {
  id?: string;
  name: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  cwd?: string;
  agent?: AutoAgentBackend;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
}): Promise<AutoAgent> {
  await ensure();
  const list = await listAutoAgents();
  let id = input.id;
  if (!id) {
    id = slug(input.name);
    let n = 2;
    while (list.some((a) => a.id === id)) id = `${slug(input.name)}-${n++}`;
  }
  const existing = list.find((a) => a.id === id);
  const agent: AutoAgent = {
    id,
    name: input.name,
    prompt: input.prompt,
    schedule: input.schedule,
    enabled: input.enabled,
    cwd: input.cwd ?? existing?.cwd,
    agent: input.agent ?? existing?.agent,
    model: input.model ?? existing?.model,
    thinkingLevel: input.thinkingLevel ?? existing?.thinkingLevel,
    tools: input.tools ?? existing?.tools,
    lastRunAt: existing?.lastRunAt,
  };
  const next = existing
    ? list.map((a) => (a.id === id ? agent : a))
    : [...list, agent];
  await Bun.write(agentsPath(), JSON.stringify(next, null, 2));
  return agent;
}

export async function deleteAutoAgent(id: string): Promise<void> {
  await ensure();
  const list = await listAutoAgents();
  await Bun.write(
    agentsPath(),
    JSON.stringify(
      list.filter((a) => a.id !== id),
      null,
      2,
    ),
  );
}

export async function setLastRun(id: string, ts: number): Promise<void> {
  const list = await listAutoAgents();
  if (!list.some((a) => a.id === id)) return;
  await Bun.write(
    agentsPath(),
    JSON.stringify(
      list.map((a) => (a.id === id ? { ...a, lastRunAt: ts } : a)),
      null,
      2,
    ),
  );
}

// ---------- in-flight runs (in-memory; serve process only) ----------
// Which agents are mid-run right now, so the UI can show a live spinner. This
// is deliberately NOT persisted: a run can't outlive the process, and on a
// fresh start nothing is running. markRunning is called synchronously at the
// top of a run so a manual /run reflects as "running" before the POST returns.
const inFlight = new Set<string>();

export function markRunning(id: string): void {
  inFlight.add(id);
}

export function clearRunning(id: string): void {
  inFlight.delete(id);
}

export function isRunning(id: string): boolean {
  return inFlight.has(id);
}

// ---------- findings ----------

export async function listFindings(status?: string): Promise<Finding[]> {
  const f = Bun.file(findingsPath());
  if (!(await f.exists())) return [];
  const rows = (await f.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Finding);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return status ? rows.filter((r) => r.status === status) : rows;
}

async function writeFindings(rows: Finding[]): Promise<void> {
  await ensure();
  await Bun.write(
    findingsPath(),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
}

export async function addFinding(input: {
  agentId: string;
  title: string;
  reasoning: string[];
  suggest?: string;
  severity: Severity;
}): Promise<Finding> {
  const rows = await listFindings();
  const finding: Finding = {
    id: randomBytes(6).toString("hex"),
    agentId: input.agentId,
    title: input.title,
    reasoning: input.reasoning,
    suggest: input.suggest,
    severity: input.severity,
    createdAt: Date.now(),
    status: "open",
  };
  rows.push(finding);
  await writeFindings(rows);
  return finding;
}

export async function updateFinding(
  id: string,
  patch: Partial<Pick<Finding, "status" | "sessionId">>,
): Promise<Finding | null> {
  const rows = await listFindings();
  let found: Finding | null = null;
  const next = rows.map((r) => {
    if (r.id === id) {
      found = { ...r, ...patch };
      return found;
    }
    return r;
  });
  if (!found) return null;
  await writeFindings(next);
  return found;
}

// ---------- finding actions (instrumentation) ----------
// Which CTA a user actually taps on a finding, and whether they had typed an
// instruction first. The FindingSheet stacks several affordances (composer
// send, one-tap "Make the change", copy for an existing session, dismiss);
// without this we have no data on which one earns its place. Append-only JSONL,
// fire-and-forget — never blocks the user action.

export type FindingActionPath = "reply" | "execute" | "copy" | "dismiss";

export type FindingActionEvent = {
  findingId: string;
  path: FindingActionPath;
  hadText: boolean;
  at: number;
};

const findingActionsPath = () => join(dir(), "finding-actions.jsonl");

export async function logFindingAction(input: {
  findingId: string;
  path: FindingActionPath;
  hadText: boolean;
}): Promise<void> {
  await ensure();
  const ev: FindingActionEvent = {
    findingId: input.findingId,
    path: input.path,
    hadText: input.hadText,
    at: Date.now(),
  };
  const f = Bun.file(findingActionsPath());
  const prev = (await f.exists()) ? await f.text() : "";
  await Bun.write(findingActionsPath(), prev + JSON.stringify(ev) + "\n");
}

// Dedup: a finding with the same normalized title for this agent that is still
// open (or was dismissed) should not be re-added. Keeps the stream from
// re-accumulating the same item every run.
// Normalise a title for recurrence matching. Numbers are stripped because the
// same problem is usually re-reported with a moved number — "sqld WAL is 2.3 GB"
// and "sqld WAL is 3.1 GB" are one problem getting worse, not two problems.
// Exact-title matching treated them as unrelated and filed both as new.
export const normTitleForTest = (t: string) => normTitle(t);

const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/[\d.,]+\s*(gb|mb|kb|tb|b|ms|s|%|×|x)?/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Record that an agent has just observed `title` again.
 *
 * Returns the existing finding when this is a recurrence, after bumping its
 * occurrence count and re-surfacing it. Returns null when it is genuinely new
 * and the caller should file it.
 *
 * The old behaviour (hasOpenSimilar -> skip) SILENTLY DISCARDED repeat
 * observations. That is the worst possible response: the signal that a problem
 * is persistent — the single most useful thing an agent can tell you — was the
 * one signal thrown away. A thing reported four times is not noise, it is the
 * thing you should be doing.
 */
export async function recordRecurrence(
  agentId: string,
  title: string,
): Promise<Finding | null> {
  const rows = await listFindings();
  const now = Date.now();
  const key = normTitle(title);
  const match = rows.find(
    (r) =>
      r.agentId === agentId &&
      UNRESOLVED.includes(r.status) &&
      normTitle(r.title) === key,
  );
  if (!match) return null;

  const occurrences = (match.occurrences ?? 1) + 1;
  // Re-surface it. A recurrence that stays "dismissed"/"read" is invisible
  // again, which is how these got lost the first time. "session" is preserved
  // so an in-flight session is not yanked out from under whoever owns it.
  const status: FindingStatus =
    match.status === "session" ? "session" : "open";

  const next = rows.map((r) =>
    r.id === match.id ? { ...r, occurrences, lastSeenAt: now, status } : r,
  );
  await writeFindings(next);
  return { ...match, occurrences, lastSeenAt: now, status };
}

/** @deprecated use recordRecurrence — kept so existing callers keep compiling. */
export async function hasOpenSimilar(
  agentId: string,
  title: string,
): Promise<boolean> {
  return (await recordRecurrence(agentId, title)) !== null;
}
