// A codex rollout's header — the session_meta line and the first user prompt —
// is written once at session start and never rewritten, because rollouts are
// append-only. The in-memory cache made every poll after the first one cheap,
// but the first poll after every restart still parsed the head of every rollout
// on the box: 3,515 files and 1.8GB here, measured at 10.6s of frozen server.
//
// These tests pin the persistence that removes that cold start, and the two
// ways it is allowed to fail: a cache written by another version, and a cache
// that is corrupt. Both must degrade to "parse it again", never to bad data.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";

const originalData = PATHS.data;
const originalCodexSessions = PATHS.codexSessions;
const roots: string[] = [];

afterEach(() => {
  PATHS.data = originalData;
  PATHS.codexSessions = originalCodexSessions;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function useTempData(): string {
  const root = mkdtempSync(join(tmpdir(), "lfg-codex-heads-"));
  roots.push(root);
  PATHS.data = join(root, "data");
  PATHS.codexSessions = join(root, "codex-sessions");
  mkdirSync(PATHS.data, { recursive: true });
  mkdirSync(PATHS.codexSessions, { recursive: true });
  return root;
}

// The loader is module-private and runs once per module instance, so each
// fixture needs a fresh import. listSessions is the only public entry that
// reaches codexThreads, so going through it proves the cache is wired into the
// real flow rather than into a helper nothing calls.
async function listThroughFreshModule() {
  const mod = (await import(`./sessions.ts?codex-head-${Math.random()}`)) as {
    listSessions: () => Promise<Array<{ sessionId: string | null }>>;
  };
  return mod.listSessions();
}

describe("codex rollout head cache", () => {
  test("a cache written by a future version is ignored, not trusted", async () => {
    useTempData();
    writeFileSync(
      join(PATHS.data, "codex-heads.json"),
      JSON.stringify({ version: 999, heads: { "/nonexistent.jsonl": { id: "bogus" } } }),
    );
    // Must not throw, and must not surface the bogus entry as a session.
    const sessions = await listThroughFreshModule();
    expect(sessions.some((s) => s.sessionId === "bogus")).toBe(false);
  });

  test("a corrupt cache falls back to parsing rather than failing", async () => {
    useTempData();
    writeFileSync(join(PATHS.data, "codex-heads.json"), "{ this is not json");
    const sessions = await listThroughFreshModule();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("the cache file is written atomically, never in place", async () => {
    // A half-written cache read by the next boot would be worse than no cache,
    // and this file is written while the server is serving.
    const source = await Bun.file("src/sessions.ts").text();
    const flush = source.slice(source.indexOf("function scheduleCodexHeadFlush"));
    const body = flush.slice(0, flush.indexOf("\n}\n"));
    expect(body).toContain(".tmp");
    expect(body).toContain("renameSync");
    // And it must not be written on every parse — that is the whole point of
    // batching a cold start's worth of work.
    expect(body).toContain("setTimeout");
  });

  test("a failed write leaves the entries marked dirty for the next attempt", async () => {
    const source = await Bun.file("src/sessions.ts").text();
    const flush = source.slice(source.indexOf("function scheduleCodexHeadFlush"));
    const body = flush.slice(0, flush.indexOf("\n}\n"));
    expect(body).toContain("codexHeadCacheDirty = pending");
  });
});
