// The live session list reaches codexThreads only to bind a codex process or
// managed row that has no rollout yet — and an unbound session is one that just
// started. Walking every rollout ever recorded to find it costs a stat per file
// (~9ms of blocking syscalls at 3,600 files, and growing) plus an object per
// file, every 2.5 seconds.
//
// ~/.codex/sessions is partitioned YYYY/MM/DD, so age is readable straight off
// the path. These tests pin that reading, because getting it wrong would either
// re-introduce the full walk (harmless but pointless) or silently stop binding
// sessions (not harmless at all).
import { describe, expect, test } from "bun:test";

// Mirrors the implementation in sessions.ts; kept here so the parsing contract
// is pinned independently of the private function.
function rolloutStartedAtFromPath(path: string): number | null {
  const m = path.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return null;
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(at) ? at : null;
}

const REAL =
  "/home/dev/.codex/sessions/2026/06/23/rollout-2026-06-23T14-32-38-019ef4e5-c005-7270-91e2-13d51e934254.jsonl";

describe("codex rollout recency window", () => {
  test("reads the start day out of a real rollout path", () => {
    expect(rolloutStartedAtFromPath(REAL)).toBe(Date.parse("2026-06-23T00:00:00Z"));
  });

  test("a path that does not carry a date is never filtered out", () => {
    // Returning null must mean "keep it" at the call site, not "drop it" — an
    // unparseable path is a reason to be careful, not a reason to lose a
    // session. The source is checked below.
    expect(rolloutStartedAtFromPath("/somewhere/else/rollout-x.jsonl")).toBeNull();
    expect(rolloutStartedAtFromPath("/home/dev/.codex/sessions/rollout-x.jsonl")).toBeNull();
  });

  test("the window is applied only when asked for, and skips nothing without a date", async () => {
    const source = await Bun.file("src/sessions.ts").text();
    const fn = source.slice(source.indexOf("async function codexThreads("));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    // No window passed → no filtering, which is what the resumable index needs.
    expect(body).toContain("const cutoff = opts?.sinceMs ?? null;");
    expect(body).toContain("if (cutoff !== null)");
    // Undated path → kept.
    expect(body).toContain("if (startedAt !== null && startedAt < cutoff) continue;");
  });

  test("the live list asks for a window measured in days, not minutes", async () => {
    const source = await Bun.file("src/sessions.ts").text();
    const window = source.match(/const CODEX_LIVE_ROLLOUT_WINDOW_MS = ([^;]+);/);
    expect(window).not.toBeNull();
    // A rollout is filed under the day it started but appended to for the life
    // of its session, so the window has to cover long-running sessions.
    const value = eval(window![1]) as number;
    expect(value).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 * 1000);
    expect(source).toContain("codexThreads({ sinceMs: Date.now() - CODEX_LIVE_ROLLOUT_WINDOW_MS })");
  });
});
