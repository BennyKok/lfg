// Registry for "aisdk" sessions — the headless AI-SDK harness sessions that run
// in parallel to the tmux claude/codex ones. Each live harness owns a JSON entry
// under data/aisdk/<sessionId>.json describing how to find and drive it, plus a
// command file <sessionId>.cmd (JSONL) that the harness tails for send/interrupt/
// close. The harness writes the actual conversation transcript via the AI-SDK
// provider to ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl — the same place the
// normal claude sessions live — so lfg's existing transcript discovery and live
// SSE stream read it unchanged. This file is the control-plane only.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";

const DIR = join(PATHS.data, "aisdk");

// Shape-compatible with tmux.ts PanePrompt / web SessionPrompt so live-ws can
// publish registry prompts on the same SSE `prompt` channel as pane selectors.
export type AisdkPromptOption = {
  index: number;
  label: string;
  selected: boolean;
  description?: string;
};
export type AisdkPrompt = {
  question: string;
  options: AisdkPromptOption[];
  header?: string;
};

export type AisdkEntry = {
  sessionId: string;
  harnessPid: number; // pid of the bun harness process (the tmux pane's child)
  tmuxName: string; // supervisor tmux session name (lifecycle/kill + managed badge)
  cwd: string;
  model: string;
  busy: boolean; // true while a turn is generating — feeds the live-view busy dot
  draftText?: string | null; // transient streamed assistant text; never persisted to transcripts
  draftUpdatedAt?: number | null;
  title?: string | null; // first user prompt, for the card before a transcript exists
  createdAt: number;
  // Which AI-SDK backend this entry drives. Absent on legacy Claude entries —
  // treat a missing value as "claude" so old entries keep working unchanged.
  agent?: "claude" | "codex" | "opencode" | "pi";
  // Resume-handle slot, reused by the backends that can't pick their transcript
  // id up front:
  //   - codex: the app-server-assigned thread id, which is ALSO the rollout
  //     transcript id under ~/.codex/sessions. Codex hands this back only AFTER
  //     turn 1, so it starts null and the harness patches it in once known.
  //   - opencode: the opencode server's resume sessionId (from the provider
  //     metadata after turn 1). Unlike codex this is NOT a transcript id —
  //     opencode writes no transcript we can read, so the opencode harness
  //     SELF-PERSISTS a Claude-shaped JSONL named by the control-plane key
  //     (== sessionId) and keeps threadId purely as the resume handle.
  //   - pi: the RpcClient session's own sessionId (pi's session-file uuid).
  //     Known almost immediately after the harness starts (before turn 1), but
  //     still patched in asynchronously like the others rather than assumed.
  // The Claude harness leaves this undefined — the deterministic sessionId
  // already IS its transcript id.
  threadId?: string | null;
  // Pending interactive question for headless harnesses (OpenCode `question`
  // tool). Live-ws publishes this as a session `prompt` event; answer/dismiss
  // route through the command file. Null/absent when no question is open.
  prompt?: AisdkPrompt | null;
};

export type AisdkCommand =
  | { type: "send"; text: string }
  | { type: "set_model"; model: string }
  | { type: "interrupt" }
  | { type: "close" }
  // OpenCode (and future headless) interactive questions — option index is the
  // 0-based index into the registry prompt.options array.
  | { type: "answer"; index: number }
  | { type: "dismiss" };

function entryPath(sessionId: string): string {
  return join(DIR, `${sessionId}.json`);
}

export function cmdPath(sessionId: string): string {
  return join(DIR, `${sessionId}.cmd`);
}

export function writeEntry(entry: AisdkEntry): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(entryPath(entry.sessionId), JSON.stringify(entry, null, 2));
}

export function readEntry(sessionId: string): AisdkEntry | null {
  try {
    return JSON.parse(readFileSync(entryPath(sessionId), "utf8")) as AisdkEntry;
  } catch {
    return null;
  }
}

// Merge a partial update into an existing entry (e.g. flipping `busy`). No-op if
// the entry is gone (session already closed).
export function patchEntry(sessionId: string, patch: Partial<AisdkEntry>): void {
  const cur = readEntry(sessionId);
  if (!cur) return;
  writeEntry({ ...cur, ...patch });
}

export function listEntries(): AisdkEntry[] {
  let files: string[];
  try {
    files = readdirSync(DIR);
  } catch {
    return [];
  }
  const out: AisdkEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const e = readEntry(f.replace(/\.json$/, ""));
    if (e) out.push(e);
  }
  return out;
}

// Find an entry by EITHER its control-plane key (sessionId) OR its codex
// threadId. The live view surfaces a codex-aisdk session under its threadId
// once known (so it deep-links to the rollout transcript), but the harness's
// command file is named by the control-plane key — so a send/interrupt/close
// arriving with the threadId must map back to the key. Returns the first match.
export function findEntryByAnyId(id: string): AisdkEntry | null {
  for (const e of listEntries()) {
    if (e.sessionId === id || (e.threadId && e.threadId === id)) return e;
  }
  return null;
}

// Remove the control-plane files for a session. The transcript under
// ~/.claude/projects is left in place (history), matching how claude sessions
// keep their transcript after the pane is killed.
export function removeEntry(sessionId: string): void {
  try {
    rmSync(entryPath(sessionId), { force: true });
  } catch {}
  try {
    rmSync(cmdPath(sessionId), { force: true });
  } catch {}
}

// Append one command for the harness to pick up. The harness tails this file.
export function appendCmd(sessionId: string, cmd: AisdkCommand): void {
  mkdirSync(DIR, { recursive: true });
  appendFileSync(cmdPath(sessionId), JSON.stringify(cmd) + "\n");
}

// Liveness: a harness entry is only real if its process is still running.
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Authoritative "is this session actually working right now" check. The harness
// sets `busy:true` at the start of a turn and clears it in a finally — but if the
// harness process dies mid-turn (killed, OOM, box restart), that finally never
// runs and `busy` stays stuck true forever, so the live view shows a dead
// session as permanently "Working". Gate the flag on the harness still being
// alive so a stuck-busy orphan reads as idle.
export function isEntryBusy(entry: AisdkEntry): boolean {
  return !!entry.busy && isPidAlive(entry.harnessPid);
}
