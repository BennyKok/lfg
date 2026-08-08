// Turns an in-browser file edit into a patch addressed to the agent.
//
// The Files panel never writes to disk. A user edit is delivered as a chat
// message containing a unified diff, and the agent applies it with its own edit
// tool. That keeps the agent the single writer of its own worktree — no lock, no
// mtime check, no "the agent changed this file under you" race — and it puts the
// change in the transcript, so later turns know the edit happened.

import { createPatch } from "diff";

/** Patch text large enough that sending it would crowd out the conversation. */
const MAX_PATCH_CHARS = 60_000;

export type FilePatchRequest = {
  /** Path shown to the agent — relative to the tree root when possible. */
  displayPath: string;
  original: string;
  edited: string;
  /** Optional free-text instruction the user typed alongside the edit. */
  note?: string;
};

export type FilePatchResult =
  | { ok: true; patch: string; message: string }
  | { ok: false; reason: "unchanged" | "too-large" };

/** Unified diff for one file, or a reason it should not be sent. */
export function buildFilePatch({ displayPath, original, edited, note }: FilePatchRequest): FilePatchResult {
  if (original === edited) return { ok: false, reason: "unchanged" };

  const patch = createPatch(displayPath, original, edited, undefined, undefined, { context: 3 });
  if (patch.length > MAX_PATCH_CHARS) return { ok: false, reason: "too-large" };

  return { ok: true, patch, message: composeMessage(displayPath, patch, note) };
}

// Phrased to suppress the model's instinct to improve on what it is given: the
// user already made this exact change by hand and is asking for it verbatim.
function composeMessage(displayPath: string, patch: string, note?: string): string {
  const trimmedNote = note?.trim();
  const lines = [
    `I edited \`${displayPath}\` in the file viewer. Apply this patch to the file exactly as written — do not reformat it, improve it, or make any other change:`,
    "",
    "```diff",
    patch.trimEnd(),
    "```",
  ];
  if (trimmedNote) lines.push("", trimmedNote);
  return lines.join("\n");
}
