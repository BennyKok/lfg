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
  statSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { removeCursor } from "./agents/backends/cmd-tail.ts";

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
  harnessPid: number; // pid of the bun harness process
  // Stable managed-runtime name. Kept as tmuxName on disk/API for backward
  // compatibility; process-supervised SDK sessions do not have a tmux pane.
  tmuxName: string;
  supervisor?: "tmux" | "process";
  bootId?: string | null;
  recoveryClaimBootId?: string | null;
  recoveredAt?: number | null;
  thinkingLevel?: string | null;
  cwd: string;
  model: string;
  busy: boolean; // true while a turn is generating — feeds the live-view busy dot
  draftText?: string | null; // transient streamed assistant text; never persisted to transcripts
  draftUpdatedAt?: number | null;
  title?: string | null; // first user prompt, for the card before a transcript exists
  // Display-name override for this session, from a custom agent profile (see
  // src/agent-profile.ts). When set, the UI shows this branded label instead of
  // the raw agent kind. Absent/null on every session without a configured
  // profile — treat a missing value as "use the agent kind".
  agentLabel?: string | null;
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
  // Our own writes must be visible to our own next read, whatever the snapshot
  // window says: a caller that writes and then lists is asking about the write
  // it just made.
  invalidateEntryCache(entryPath(entry.sessionId));
}

/**
 * Parsed entries, keyed by path and validated against the file's mtime.
 *
 * Building the session list walks this registry about eight times — several
 * direct listEntries() calls plus findEntryByAnyId, which scans the whole
 * directory per lookup. With ~90 live sessions that was ~700 reads and ~700
 * JSON.parse calls per rebuild, and it measured as 60% of the rebuild's CPU:
 * the single largest cost in the whole session list, larger than every process
 * and tmux scan combined.
 *
 * Caching on mtime rather than on a clock keeps this correct across processes.
 * Harnesses write their own entries, so a timed cache could hide a busy flag
 * that another process just flipped; a stat cannot. Nanosecond precision means
 * two writes inside the same millisecond can't alias either. The stat still
 * costs a syscall per file, but not a read and not a parse.
 */
type CachedEntry = { mtimeNs: bigint; size: bigint; entry: AisdkEntry };
const entryCache = new Map<string, CachedEntry>();

/** Drop what this process just changed, so its own next read goes to disk. */
function invalidateEntryCache(path: string): void {
  entryCache.delete(path);
  snapshot = null;
}

function readEntryAt(path: string): AisdkEntry | null {
  let mtimeNs: bigint;
  let size: bigint;
  try {
    const st = statSync(path, { bigint: true });
    mtimeNs = st.mtimeNs;
    size = st.size;
  } catch {
    entryCache.delete(path);
    return null;
  }
  const hit = entryCache.get(path);
  if (hit && hit.mtimeNs === mtimeNs && hit.size === size) return hit.entry;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as AisdkEntry;
    entryCache.set(path, { mtimeNs, size, entry });
    return entry;
  } catch {
    entryCache.delete(path);
    return null;
  }
}

export function readEntry(sessionId: string): AisdkEntry | null {
  return readEntryAt(entryPath(sessionId));
}

// Merge a partial update into an existing entry (e.g. flipping `busy`). No-op if
// the entry is gone (session already closed).
export function patchEntry(sessionId: string, patch: Partial<AisdkEntry>): void {
  const cur = readEntry(sessionId);
  if (!cur) return;
  writeEntry({ ...cur, ...patch });
}

/**
 * One directory walk per burst.
 *
 * The mtime cache above removes the reads and the parses, but not the syscalls:
 * eight walks over ~90 entries is still ~700 stats per session-list rebuild,
 * and that measured as the largest remaining cost. This snapshot collapses the
 * walks a single rebuild does into one.
 *
 * The window is deliberately far shorter than anything that polls this data —
 * the session list rebuilds on a multi-second cadence and the live socket polls
 * at 400ms — so an entry another process writes is still picked up on the very
 * next poll, not a later one. Past the window the mtime check runs again, so
 * this only ever collapses duplicate work inside one burst.
 */
const SNAPSHOT_WINDOW_MS = 50;
let snapshot: { at: number; entries: AisdkEntry[] } | null = null;

export function listEntries(): AisdkEntry[] {
  const now = Date.now();
  if (snapshot && now - snapshot.at < SNAPSHOT_WINDOW_MS) return snapshot.entries;
  let files: string[];
  try {
    files = readdirSync(DIR);
  } catch {
    entryCache.clear();
    snapshot = { at: now, entries: [] };
    return [];
  }
  const out: AisdkEntry[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = join(DIR, f);
    seen.add(path);
    const e = readEntryAt(path);
    if (e) out.push(e);
  }
  // Closed sessions delete their entry; drop their cached parse with them so
  // this map tracks the directory instead of growing for the process's life.
  for (const path of entryCache.keys()) if (!seen.has(path)) entryCache.delete(path);
  snapshot = { at: now, entries: out };
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
  invalidateEntryCache(entryPath(sessionId));
  try {
    rmSync(cmdPath(sessionId), { force: true });
  } catch {}
  // The harness's durable tail cursor goes with the command file it points into;
  // a stray cursor would otherwise apply to a freshly recreated command file.
  removeCursor(cmdPath(sessionId));
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

export function currentBootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Force-stop a direct harness that did not consume its graceful `close`
// command. Contained sessions live in their own transient systemd service;
// stopping that unit reaps the whole cgroup. Plain sessions are single harness
// processes whose SDK child is first given a grace window by the caller.
export function terminateHarnessProcess(entry: AisdkEntry): boolean {
  try {
    const cgroup = readFileSync(`/proc/${entry.harnessPid}/cgroup`, "utf8");
    const unit = cgroup.match(/(lfg-agent-[^/\s]+\.service)/)?.[1];
    if (unit) {
      return Bun.spawnSync(["systemctl", "--user", "stop", unit]).exitCode === 0;
    }
  } catch {}
  try {
    process.kill(entry.harnessPid, "SIGTERM");
    return true;
  } catch {
    return !isPidAlive(entry.harnessPid);
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
