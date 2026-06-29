// Pipeline runner: executes a multi-agent pipeline step by step.
//
// Flow for an agent step:
//   1. Build prompt (inject previous context if requested).
//   2. Spawn the agent in a fresh tmux session via the existing spawn helpers.
//   3. Wait for the session to start processing (become busy).
//   4. Poll until the session goes idle and STAYS idle for IDLE_CONFIRM_MS.
//   5. Extract a context summary from the agent's transcript.
//   6. Hand the context to the next step.
//
// Flow for a run step:
//   1. Execute the shell command via Bun.spawn.
//   2. Stream stdout/stderr into the step log.
//   3. Resolve on exit (ok or fail).

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { PATHS } from "../config.ts";
import {
  spawnManagedSession,
  spawnManagedCodexSession,
  spawnManagedGrokSession,
  panePidForSession,
  isBusy,
  capturePane,
  tmuxKillSession,
  tmuxHasSession,
} from "../tmux.ts";
import { addManaged, removeManaged } from "../managed.ts";
import { sessionIdForPid } from "../sessions.ts";
import { normalizeLineMessages } from "../sessions.ts";
import type { Pipeline, PipelineRun, PipelineStep, StepState } from "./types.ts";

const RUNS_DIR = join(PATHS.data, "pipeline-runs");

// How long (ms) the pane must be idle before we consider the step done.
const IDLE_CONFIRM_MS = 20_000;
// How long (ms) to wait for the session to first become busy after spawn.
const BUSY_WAIT_MS = 90_000;
// Polling interval while waiting.
const POLL_MS = 4_000;
// Max context chars to extract from a previous agent's transcript.
const MAX_CONTEXT_CHARS = 8_000;

// ── Persistence ──────────────────────────────────────────────────────────────

function runPath(id: string): string {
  return join(RUNS_DIR, `${id}.json`);
}

function writeRun(run: PipelineRun): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(runPath(run.id), JSON.stringify(run, null, 2));
}

export function readRun(id: string): PipelineRun | null {
  try {
    return JSON.parse(readFileSync(runPath(id), "utf8")) as PipelineRun;
  } catch {
    return null;
  }
}

export function listRunIds(): string[] {
  try {
    return readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// ── Context extraction ────────────────────────────────────────────────────────

// Read a Claude-format JSONL transcript and return the last MAX_CONTEXT_CHARS
// of assistant text — enough for the next agent to understand what was done.
async function extractClaudeContext(transcriptPath: string): Promise<string> {
  try {
    const text = await Bun.file(transcriptPath).text();
    const lines = text.split("\n").filter((l) => l.trim());
    const parts: string[] = [];
    for (const line of lines) {
      for (const msg of normalizeLineMessages(line)) {
        if (msg.role === "assistant" && msg.kind === "text" && msg.text.trim()) {
          parts.push(msg.text.trim());
        }
      }
    }
    const full = parts.join("\n\n");
    return full.length > MAX_CONTEXT_CHARS ? full.slice(-MAX_CONTEXT_CHARS) : full;
  } catch {
    return "";
  }
}

// ── Session idle detection ────────────────────────────────────────────────────

// Wait for the tmux session to first become busy, then wait for it to go idle
// and stay idle for IDLE_CONFIRM_MS. Returns "done" or "timeout"/"error".
async function waitForSessionDone(
  tmuxName: string,
  log: (s: string) => void,
  maxMs = 30 * 60_000,
): Promise<"done" | "timeout" | "gone"> {
  const deadline = Date.now() + maxMs;
  let becameBusy = false;
  let idleSince: number | null = null;

  // Wait for busy (session starts up then processes the first prompt).
  const busyDeadline = Date.now() + BUSY_WAIT_MS;
  while (Date.now() < busyDeadline) {
    if (!tmuxHasSession(tmuxName)) return "gone";
    const pane = capturePane(`=${tmuxName}`);
    if (pane && isBusy(pane)) {
      becameBusy = true;
      log(`[pipeline] session ${tmuxName} is working…`);
      break;
    }
    await Bun.sleep(POLL_MS);
  }

  if (!becameBusy) {
    log(`[pipeline] session ${tmuxName} never became busy — treating as done`);
    return "done";
  }

  // Now poll until idle for IDLE_CONFIRM_MS.
  while (Date.now() < deadline) {
    if (!tmuxHasSession(tmuxName)) {
      log(`[pipeline] session ${tmuxName} exited`);
      return "gone";
    }
    const pane = capturePane(`=${tmuxName}`);
    const busy = pane ? isBusy(pane) : false;

    if (busy) {
      idleSince = null;
    } else {
      if (idleSince === null) idleSince = Date.now();
      const idleMs = Date.now() - idleSince;
      if (idleMs >= IDLE_CONFIRM_MS) {
        log(`[pipeline] session ${tmuxName} idle for ${Math.round(idleMs / 1000)}s — done`);
        return "done";
      }
    }
    await Bun.sleep(POLL_MS);
  }

  return "timeout";
}

// ── Session spawning ──────────────────────────────────────────────────────────

function makeSessionName(pipeline: string, stepIndex: number): string {
  const rand = randomBytes(3).toString("hex");
  return `lfg-pipe-${pipeline}-s${stepIndex}-${rand}`;
}

function buildAgentPrompt(basePrompt: string, contextSummary: string | undefined): string {
  if (!contextSummary?.trim()) return basePrompt;
  return (
    `## Context from the previous agent\n\n` +
    `The following is a summary of what was accomplished in the previous step. ` +
    `Use it to understand the current state of the codebase before starting your task.\n\n` +
    `${contextSummary.trim()}\n\n` +
    `---\n\n` +
    `## Your task\n\n` +
    basePrompt
  );
}

async function spawnAgent(opts: {
  step: Extract<PipelineStep, { kind: "agent" }>;
  tmuxName: string;
  cwd: string;
  prompt: string;
  log: (s: string) => void;
}): Promise<{ ok: boolean; error?: string }> {
  const { step, tmuxName, cwd, prompt, log } = opts;
  log(`[pipeline] spawning ${step.agent} session "${tmuxName}" in ${cwd}`);

  if (step.agent === "claude") {
    return spawnManagedSession({ name: tmuxName, cwd, prompt, model: step.model });
  }
  if (step.agent === "codex") {
    return spawnManagedCodexSession({ name: tmuxName, cwd, prompt, model: step.model });
  }
  if (step.agent === "grok") {
    return spawnManagedGrokSession({ name: tmuxName, cwd, prompt, model: step.model });
  }
  return { ok: false, error: `unsupported agent kind: ${step.agent}` };
}

// ── Step runners ─────────────────────────────────────────────────────────────

async function runAgentStep(
  stepState: StepState,
  step: Extract<PipelineStep, { kind: "agent" }>,
  run: PipelineRun,
  prevContext: string | undefined,
  log: (s: string) => void,
): Promise<string | undefined> {
  const tmuxName = makeSessionName(run.pipeline, stepState.index);
  stepState.tmuxName = tmuxName;
  stepState.log.push(`spawning ${step.agent} as ${tmuxName}`);
  writeRun(run);

  const prompt = buildAgentPrompt(step.prompt, step.context === "transcript_summary" ? prevContext : undefined);

  const spawn = await spawnAgent({ step, tmuxName, cwd: run.cwd, prompt, log });
  if (!spawn.ok) {
    stepState.status = "failed";
    stepState.error = spawn.error ?? "spawn failed";
    stepState.log.push(`spawn error: ${stepState.error}`);
    return undefined;
  }

  addManaged({ tmuxName, cwd: run.cwd, createdAt: Date.now(), agent: step.agent });
  writeRun(run);

  // Wait for session to finish.
  const result = await waitForSessionDone(tmuxName, (msg) => {
    stepState.log.push(msg);
    log(msg);
    writeRun(run);
  });

  if (result === "timeout") {
    stepState.status = "failed";
    stepState.error = "timed out waiting for agent to finish";
    stepState.log.push(stepState.error);
    removeManaged(tmuxName);
    return undefined;
  }

  // Extract context from Claude transcripts.
  let contextSummary: string | undefined;
  if (step.agent === "claude") {
    const pid = panePidForSession(tmuxName);
    if (pid) {
      const sessionId = sessionIdForPid(pid);
      if (sessionId) {
        const HOME = process.env.HOME ?? homedir();
        // Claude stores transcripts under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
        // The encoded path replaces / with - (leading / dropped).
        const encoded = run.cwd.replace(/^\//, "").replace(/\//g, "-");
        const tPath = join(HOME, ".claude", "projects", encoded, `${sessionId}.jsonl`);
        const summary = await extractClaudeContext(tPath);
        if (summary) {
          contextSummary = summary;
          stepState.contextSummary = summary;
          stepState.transcriptPath = tPath;
          stepState.log.push(`extracted ${summary.length} chars of context`);
        }
      }
    }
  }

  // Keep the session alive (user can inspect it in the UI) — don't kill it.
  removeManaged(tmuxName);

  stepState.status = "done";
  stepState.doneAt = Date.now();
  return contextSummary;
}

async function runShellStep(
  stepState: StepState,
  command: string,
  cwd: string,
  log: (s: string) => void,
): Promise<void> {
  stepState.log.push(`$ ${command}`);
  log(`[pipeline] running: ${command}`);
  writeRun({ ...stepState } as unknown as PipelineRun); // flush

  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const decoder = new TextDecoder();
  const collectStream = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream as any) {
      const text = decoder.decode(chunk).replace(/\n$/, "");
      if (text) {
        stepState.log.push(text);
        log(`[pipeline] ${text}`);
      }
    }
  };

  await Promise.all([collectStream(proc.stdout), collectStream(proc.stderr)]);
  const exitCode = await proc.exited;
  stepState.exitCode = exitCode;

  if (exitCode !== 0) {
    stepState.status = "failed";
    stepState.error = `command exited with code ${exitCode}`;
    stepState.log.push(stepState.error);
  } else {
    stepState.status = "done";
    stepState.doneAt = Date.now();
    stepState.log.push(`exited 0`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export type RunPipelineOpts = {
  cwd: string;
  id?: string;
  onLog?: (line: string) => void;
};

export function generateRunId(): string {
  return `${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export async function runPipeline(
  pipeline: Pipeline,
  opts: RunPipelineOpts,
): Promise<PipelineRun> {
  const id = opts.id ?? generateRunId();
  const log = opts.onLog ?? (() => {});

  const steps: StepState[] = pipeline.steps.map((s, i) => ({
    index: i,
    kind: s.kind,
    status: "pending",
    log: [],
  }));

  const run: PipelineRun = {
    id,
    pipeline: pipeline.name,
    cwd: opts.cwd,
    startedAt: Date.now(),
    status: "running",
    steps,
  };

  writeRun(run);
  log(`[pipeline] run ${id} started for pipeline "${pipeline.name}"`);

  let prevContext: string | undefined;

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];
    const stepState = run.steps[i];

    stepState.status = "running";
    stepState.startedAt = Date.now();
    writeRun(run);
    log(`[pipeline] step ${i + 1}/${pipeline.steps.length}: ${step.kind === "agent" ? step.agent : "run"}`);

    if (step.kind === "agent") {
      const ctx = await runAgentStep(stepState, step, run, prevContext, log);
      prevContext = ctx;
    } else {
      await runShellStep(stepState, step.command, run.cwd, log);
    }

    writeRun(run);

    if (stepState.status === "failed") {
      run.status = "failed";
      run.error = `step ${i + 1} failed: ${stepState.error}`;
      run.doneAt = Date.now();
      writeRun(run);
      log(`[pipeline] run ${id} FAILED at step ${i + 1}: ${stepState.error}`);
      return run;
    }
  }

  run.status = "done";
  run.doneAt = Date.now();
  writeRun(run);
  log(`[pipeline] run ${id} completed successfully`);
  return run;
}
