// Locating a Claude conversation when a session's original cwd is gone.
//
// Claude Code stores each conversation at
//   ~/.claude/projects/<cwd with "/" replaced by "-">/<sessionId>.jsonl
// and resolves `--resume <id>` against the project dir derived from the cwd it
// is launched in. The cwd is therefore part of the lookup key, not just where
// the agent happens to run.
//
// LFG runs sessions in per-session git worktrees, and the worktree sweeper
// reclaims a worktree once its tmux session is gone. The conversation survives
// (it lives under ~/.claude, not in the worktree) but its project dir is now
// named after a directory that no longer exists. On resume, resolveResumeCwd
// correctly falls back to the repo root — and Claude then looks for the
// conversation under the FALLBACK cwd's project dir, doesn't find it, and exits
// immediately with "No conversation found with session ID: …". The harness dies
// before it registers itself, so the resume just silently stops.
//
// Fix: before resuming into a different cwd, make sure the conversation is
// visible from that cwd by copying the transcript into the target project dir.
// The transcript is append-only history; the copy is what Claude reads to
// rebuild context, and the original is left untouched.

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Resolved per call rather than captured at import: the value is stable in
// production, and reading it lazily keeps this module testable against a
// temporary HOME.
export function claudeProjectsDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude", "projects");
}

// Claude's cwd -> project dir encoding: every "/" becomes "-", including the
// leading one (so /home/dev/x -> -home-dev-x).
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function conversationPathFor(cwd: string, sessionId: string): string {
  return join(claudeProjectsDir(), encodeClaudeCwd(cwd), `${sessionId}.jsonl`);
}

// Find an existing conversation file for this session id anywhere under
// ~/.claude/projects, preferring the largest (a partial copy left by an earlier
// interrupted resume should never win over the real history).
export function findConversationFile(sessionId: string): string | null {
  const root = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  let best: { path: string; size: number } | null = null;
  for (const d of dirs) {
    const p = join(root, d, `${sessionId}.jsonl`);
    let size: number;
    try {
      size = statSync(p).size;
    } catch {
      continue;
    }
    if (!best || size > best.size) best = { path: p, size };
  }
  return best?.path ?? null;
}

export type EnsureResult = "present" | "copied" | "missing";

// Make the conversation for `sessionId` resolvable from `cwd`.
//
// - "present": already there, nothing done (the common case).
// - "copied":  found under another project dir and copied into place, so
//              `--resume` will now succeed from this cwd.
// - "missing": no transcript anywhere; the caller should expect the resume to
//              start a fresh conversation rather than silently die.
export function ensureConversationVisibleFrom(
  cwd: string,
  sessionId: string,
): EnsureResult {
  const target = conversationPathFor(cwd, sessionId);
  if (existsSync(target)) return "present";

  const source = findConversationFile(sessionId);
  if (!source || source === target) return source ? "present" : "missing";

  try {
    mkdirSync(join(claudeProjectsDir(), encodeClaudeCwd(cwd)), { recursive: true });
    copyFileSync(source, target);
    return "copied";
  } catch {
    return "missing";
  }
}
