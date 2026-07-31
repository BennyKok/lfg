// Tailing the harness command file (data/aisdk/<sessionId>.cmd).
//
// Every harness backend (aisdk, codex-aisdk, opencode, pi) reads its control
// input from an append-only JSONL command file. Getting the cursor arithmetic
// right matters more than it looks: the file is the FULL command history of the
// session, so a cursor that wrongly rewinds to 0 re-sends every message the user
// ever typed as a brand-new turn.
//
// Two bugs this module exists to prevent:
//
// 1. BYTES vs CHARACTERS. The cursor was seeded from `statSync().size` (bytes)
//    but compared against `readFileSync(f,"utf8").length` (UTF-16 code units).
//    Any non-ASCII byte in the history — "…", "—", "→", emoji, CJK — makes
//    bytes > chars, so the poll read `length < offset`, concluded the file had
//    been truncated, reset the cursor to 0, and replayed the entire history on
//    the next tick. Smart punctuation from voice transcription triggered this
//    essentially every time. Everything here is in BYTES, end to end.
//
// 2. TORN APPENDS. A poll can land between the write of a line's bytes and its
//    trailing newline. Consuming to end-of-buffer would parse half a JSON object
//    and drop the command. We only ever consume through the last complete
//    newline and leave the remainder for the next tick.
//
// The cursor is also persisted (<cmd file>.cursor) so a harness that restarts
// after a crash resumes exactly where it stopped: commands queued while it was
// down still get delivered, and commands already delivered do not repeat.

import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";

export function cursorPath(cmdFile: string): string {
  return `${cmdFile}.cursor`;
}

// Read the persisted byte cursor. Returns null when there is none (first launch)
// or it is unusable, which callers treat as "seed from the current end".
export function readCursor(cmdFile: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(cursorPath(cmdFile), "utf8");
  } catch {
    return null;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

// Persist the byte cursor atomically — a half-written cursor file would be
// parsed as a smaller offset and replay commands.
export function writeCursor(cmdFile: string, offset: number): void {
  const tmp = `${cursorPath(cmdFile)}.tmp`;
  try {
    writeFileSync(tmp, `${offset}\n`);
    renameSync(tmp, cursorPath(cmdFile));
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

export function removeCursor(cmdFile: string): void {
  try {
    rmSync(cursorPath(cmdFile), { force: true });
  } catch {}
}

export type CmdRead = {
  // Complete JSONL lines that became available since `offset`.
  lines: string[];
  // The byte offset to poll from next.
  offset: number;
};

// Read complete lines appended to `cmdFile` after byte offset `offset`.
// Pure w.r.t. the cursor: it returns the next offset rather than mutating state,
// which is what makes the byte arithmetic straightforward to test.
export function readNewCmdLines(cmdFile: string, offset: number): CmdRead {
  let buf: Buffer;
  try {
    buf = readFileSync(cmdFile);
  } catch {
    return { lines: [], offset }; // not created yet
  }

  let start = offset;
  // Genuine truncation/rotation only — both sides are byte counts now, so this
  // no longer fires on multi-byte content.
  if (buf.length < start) start = 0;
  if (buf.length === start) return { lines: [], offset: start };

  // Consume through the last complete line; leave any torn tail for next tick.
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < start) return { lines: [], offset: start };

  const end = lastNewline + 1;
  const text = buf.toString("utf8", start, end);
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return { lines, offset: end };
}

// Where a starting harness should begin reading.
//
// - A persisted cursor wins: it is the durable record of what this session has
//   already consumed, so a crash/restart delivers the backlog exactly once.
// - With no cursor (first launch, or a session predating cursor files) we seed
//   from the current end. Commands already in the file belong to a previous
//   incarnation that consumed them; replaying would re-send the whole history.
// - A cursor past the current end means the file was rotated: start over.
export function initialCmdOffset(cmdFile: string): number {
  let size = 0;
  try {
    size = readFileSync(cmdFile).length;
  } catch {
    return 0; // file not created yet; nothing to skip
  }
  const persisted = readCursor(cmdFile);
  if (persisted === null) return size;
  return persisted > size ? 0 : persisted;
}
