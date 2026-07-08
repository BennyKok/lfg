// Ask-user questions — the human-in-the-loop channel for headless agents.
//
// When the supervisor (or any auto agent) hits a decision it shouldn't make
// alone, it POSTs a question here. We persist it, raise a push notification,
// and the agent long-polls for the answer. The user replies either by typing
// in the web UI or by talking to the voice agent (which answers on their
// behalf). Answers wake any blocked long-poll via an in-memory waiter map.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "../config.ts";

// open → answered (user replied) → handled (the agent acted on the reply).
// "handled" is what stops the supervisor re-acting on the same answer each run.
export type AskStatus = "open" | "answered" | "expired" | "handled";

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
// Resolvers keyed by question id. answerQuestion()/expireQuestion() fire them so
// a blocked POST /api/ask returns the moment a human responds. Purely in-memory:
// a waiter cannot outlive the request that created it.
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

export async function listQuestions(status?: AskStatus): Promise<AskQuestion[]> {
  const f = Bun.file(path());
  if (!(await f.exists())) return [];
  const rows = (await f.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AskQuestion);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return status ? rows.filter((r) => r.status === status) : rows;
}

export async function getQuestion(id: string): Promise<AskQuestion | null> {
  return (await listQuestions()).find((q) => q.id === id) ?? null;
}

async function writeAll(rows: AskQuestion[]): Promise<void> {
  await ensure();
  await Bun.write(
    path(),
    rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
  );
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

export async function expireQuestion(id: string): Promise<void> {
  const rows = await listQuestions();
  let found: AskQuestion | null = null;
  const next = rows.map((r) => {
    if (r.id === id && r.status === "open") {
      found = { ...r, status: "expired" };
      return found;
    }
    return r;
  });
  if (!found) return;
  await writeAll(next);
  wake(found);
}
