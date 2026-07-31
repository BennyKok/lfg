// Ask-user questions — the human-in-the-loop channel for headless agents.
//
// When the supervisor (or any auto agent) hits a decision it shouldn't make
// alone, it POSTs a question here. We persist it, raise a push notification,
// and the agent long-polls for the answer. The user replies either by typing
// in the web UI or by talking to the voice agent (which answers on their
// behalf). Answers wake any blocked long-poll via an in-memory waiter map.

import { mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../config.ts";

// open → answered (user replied) → handled (the agent acted on the reply), or
// open → dismissed/expired when no answer should be delivered.
// "handled" is what stops the supervisor re-acting on the same answer each run.
export type AskStatus = "open" | "answered" | "dismissed" | "expired" | "handled";

export type AskQuestion = {
  id: string;
  question: string;
  options?: string[]; // optional suggested one-tap answers
  agentId?: string | null; // which auto agent asked (if any)
  sessionId?: string | null; // related coding session (if any)
  user?: string | null; // who should answer — scopes push + UI
  // Fire-and-forget asks (the MCP lfg_ask_user tool): the asking agent does NOT
  // block or poll — when the user answers, the reply is pushed verbatim into
  // sessionId as a new user message. Legacy asks (pushback falsy) keep the old
  // close/send/none heuristic on delivery.
  pushback?: boolean;
  status: AskStatus;
  answer?: string | null;
  answeredVia?: "voice" | "web" | null;
  createdAt: number;
  answeredAt?: number | null;
};

const dir = () => join(PATHS.data, "ask");
const path = () => join(dir(), "questions.jsonl");

async function ensure() {
  await mkdir(dir(), { recursive: true });
}

// ---------- in-memory long-poll waiters ----------
// Resolvers keyed by question id. Anything that resolves a question — an
// answer, a dismissal, the TTL sweep — fires them, so a blocked POST /api/ask
// returns the moment a human responds. Purely in-memory: a waiter cannot
// outlive the request that created it.
const waiters = new Map<string, Set<(q: AskQuestion) => void>>();

function wake(q: AskQuestion) {
  const set = waiters.get(q.id);
  if (!set) return;
  for (const fn of set) fn(q);
  waiters.delete(q.id);
}

/** Resolve once the question leaves "open", or after timeoutMs (whichever first). */
export function waitForAnswer(id: string, timeoutMs: number): Promise<AskQuestion | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (q: AskQuestion | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const set = waiters.get(id);
      if (set) {
        set.delete(onWake);
        if (!set.size) waiters.delete(id);
      }
      resolve(q);
    };
    const onWake = (q: AskQuestion) => finish(q);
    const timer = setTimeout(() => finish(null), timeoutMs);
    let set = waiters.get(id);
    if (!set) waiters.set(id, (set = new Set()));
    set.add(onWake);
  });
}

// ---------- persistence ----------

// The web client polls the open-question list every 5s, and each poll re-read,
// re-parsed and re-sorted the whole store. Keep the parsed rows while the file
// on disk is unchanged; mtime+size means a write from another process (the MCP
// server answers questions out-of-band) is picked up on the next read.
//
// Every mutator here rewrites the whole file through `writeAll`, which drops
// this cache explicitly.
//
// The subtle part is writes from ANOTHER process. Unlike an append-only log,
// a whole-file rewrite can land on the same byte length, and the kernel stamps
// mtime at timer-tick resolution — two writes inside one tick share a
// timestamp. mtime+size alone would then serve a stale parse and lose the
// write. So an entry is only memoized once the file has been quiet longer than
// that window: any later rewrite is guaranteed a newer stamp. Steady state
// (a store nobody has touched for seconds, polled every 5s) still caches.
const STAT_SETTLE_MS = 1_000;
let questionsCache: { mtimeMs: number; size: number; rows: AskQuestion[] } | null = null;

export async function listQuestions(status?: AskStatus): Promise<AskQuestion[]> {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path());
  } catch {
    questionsCache = null;
    return [];
  }
  const cached = questionsCache;
  // Callers mutate what they get back (`addQuestion` pushes onto it), so the
  // cached array is never handed out directly.
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return status ? cached.rows.filter((r) => r.status === status) : cached.rows.slice();
  }
  const rows = (await Bun.file(path()).text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AskQuestion);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  questionsCache =
    Date.now() - stat.mtimeMs >= STAT_SETTLE_MS
      ? { mtimeMs: stat.mtimeMs, size: stat.size, rows }
      : null;
  return status ? rows.filter((r) => r.status === status) : rows.slice();
}

export async function getQuestion(id: string): Promise<AskQuestion | null> {
  return (await listQuestions()).find((q) => q.id === id) ?? null;
}

async function writeAll(rows: AskQuestion[]): Promise<void> {
  await ensure();
  // Invalidate around the write, not just after it: a read that lands while
  // the file is half-rewritten must not be able to leave a cache entry behind.
  questionsCache = null;
  await Bun.write(
    path(),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
  questionsCache = null;
}

export async function addQuestion(input: {
  question: string;
  options?: string[];
  agentId?: string | null;
  sessionId?: string | null;
  user?: string | null;
  pushback?: boolean;
}): Promise<AskQuestion> {
  const rows = await listQuestions();
  const q: AskQuestion = {
    id: randomBytes(6).toString("hex"),
    question: input.question.trim(),
    options: input.options?.map((o) => o.trim()).filter(Boolean),
    agentId: input.agentId ?? null,
    sessionId: input.sessionId ?? null,
    user: input.user ?? null,
    pushback: input.pushback ?? false,
    status: "open",
    answer: null,
    answeredVia: null,
    createdAt: Date.now(),
    answeredAt: null,
  };
  rows.push(q);
  await writeAll(rows);
  return q;
}

export async function answerQuestion(
  id: string,
  input: { answer: string; via?: "voice" | "web" },
): Promise<AskQuestion | null> {
  const rows = await listQuestions();
  let found: AskQuestion | null = null;
  const next = rows.map((r) => {
    if (r.id === id && r.status === "open") {
      found = {
        ...r,
        status: "answered",
        answer: input.answer,
        answeredVia: input.via ?? "web",
        answeredAt: Date.now(),
      };
      return found;
    }
    return r;
  });
  if (!found) return null;
  await writeAll(next);
  wake(found);
  return found;
}

/** Mark an answered question as acted-upon so it isn't handled twice. */
export async function markHandled(id: string): Promise<AskQuestion | null> {
  const rows = await listQuestions();
  let found: AskQuestion | null = null;
  const next = rows.map((r) => {
    if (r.id === id && r.status === "answered") {
      found = { ...r, status: "handled" };
      return found;
    }
    return r;
  });
  if (!found) return null;
  await writeAll(next);
  return found;
}

/**
 * Dismiss an open question without delivering an answer to the asking agent.
 * Already-resolved questions are returned unchanged so retries are idempotent.
 */
export async function dismissQuestion(id: string): Promise<AskQuestion | null> {
  const rows = await listQuestions();
  let found: AskQuestion | null = null;
  let changed = false;
  const next = rows.map((r) => {
    if (r.id !== id) return r;
    found = r;
    if (r.status !== "open") return r;
    changed = true;
    found = { ...r, status: "dismissed" };
    return found;
  });
  if (!found) return null;
  if (!changed) return found;
  await writeAll(next);
  wake(found);
  return found;
}

/**
 * How long an unanswered ask stays live. Past it the question is stale: the
 * work it was blocking has moved on, and re-surfacing it does active harm —
 * the channel adapter can route the user's next unrelated message into it as
 * an "answer" (see the omg imsg pending-question park), and the voice agent
 * keeps reading it out. Chosen to match the imsg side's own park TTL so the
 * two ends agree on what "still answerable" means.
 */
export const ASK_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Flip every `open` ask older than `ttlMs` to `expired`, and return them.
 *
 * Called from the read paths that SURFACE open questions rather than from a
 * timer: this store is a whole-file rewrite with no locking, so a background
 * tick racing a concurrent `addQuestion` would clobber it. Sweeping on read
 * means the rewrite only happens on the request that would otherwise have
 * handed out a stale question, and a no-op sweep never writes at all.
 *
 * Long-poll waiters are woken (an expired question resolves the poll rather
 * than hanging it to the timeout) instead of being left to time out.
 */
export async function sweepExpiredQuestions(ttlMs: number = ASK_TTL_MS): Promise<AskQuestion[]> {
  const rows = await listQuestions();
  const cutoff = Date.now() - ttlMs;
  const expired: AskQuestion[] = [];
  const next = rows.map((r) => {
    if (r.status !== "open" || r.createdAt > cutoff) return r;
    const flipped: AskQuestion = { ...r, status: "expired" };
    expired.push(flipped);
    return flipped;
  });
  if (!expired.length) return [];
  await writeAll(next);
  for (const q of expired) wake(q);
  return expired;
}
