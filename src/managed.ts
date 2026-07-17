// Registry of tmux sessions lfg started itself. Owning the session's tmux
// name is what makes the lifecycle deterministic: we created `tmux new-session
// -s <name>`, so we know the exact pane and can resolve its authoritative
// sessionId directly — no pgrep/parent-walk/newest-unclaimed guessing, so none
// of the ghost-panel / wrong-pid problems that plague attached sessions. The
// file survives a server restart so lfg still knows which live sessions it
// owns (for the managed badge, clean kill-session teardown, and following the
// sessionId when /clear rotates it).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./config.ts";
import { LFG_CAPABILITY_VERSION } from "./lfg-capabilities.ts";

const FILE = `${PATHS.data}/managed-sessions.json`;

export type ManagedSession = {
  tmuxName: string;
  cwd: string;
  createdAt: number;
  agent?: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode" | "grok" | "cursor" | "hermes" | "copilot";
  // Stable id shown to clients for lfg-created sessions. For agents that mint a
  // native transcript id later (Claude/Codex CLI, Codex AI-SDK, Grok), this is
  // the durable control-plane id while nativeSessionId records the provider id.
  sessionId?: string;
  nativeSessionId?: string;
  launchState?: "launching" | "running" | "failed";
  launchError?: string;
  model?: string;
  title?: string;
  /** Stable UI project label. Kept because resumed sessions can report a stale cwd. */
  project?: string;
  parentSessionId?: string;
  parentNativeSessionId?: string;
  parentAgent?: string;
  spawnedBy?: "subagent" | "fork" | "finding" | "voice" | string;
  /** LFG agent capability contract/tool catalog present when this process launched. */
  capabilityVersion?: string;
  /** Main repo checkout when cwd is an auto-provisioned worktree. */
  repoRoot?: string;
  worktreeBranch?: string;
};

function readAll(): Record<string, ManagedSession> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, ManagedSession>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, ManagedSession>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
}

export function listManaged(): ManagedSession[] {
  return Object.values(readAll());
}

export function addManaged(rec: ManagedSession): void {
  const all = readAll();
  all[rec.tmuxName] = {
    ...rec,
    capabilityVersion: rec.capabilityVersion ?? LFG_CAPABILITY_VERSION,
  };
  writeAll(all);
}

export function patchManaged(tmuxName: string, patch: Partial<ManagedSession>): void {
  const all = readAll();
  const cur = all[tmuxName];
  if (!cur) return;
  all[tmuxName] = { ...cur, ...patch };
  writeAll(all);
}

export function removeManaged(tmuxName: string): void {
  const all = readAll();
  if (tmuxName in all) {
    delete all[tmuxName];
    writeAll(all);
  }
}

// Is this tmux name one we started? `target` may be a full pane target
// (`name:0.0`) or a bare session name — we compare on the session-name segment.
export function isManagedName(target: string | null): boolean {
  if (!target) return false;
  const name = target.split(":")[0];
  return name in readAll();
}
