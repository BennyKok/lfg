// Ask-store TTL sweep. The bug this pins: nothing ever expired an ask, so an
// unanswered one stayed `open` forever — it kept being re-surfaced in the web
// feed and the voice snapshot, and (the harmful part) `lfg connect` kept
// emitting it as an `auto.question` channel event, where the omg imsg brain
// could bind an unrelated inbound message to it as the "answer".
//
// Also covers the read cache: every mutator rewrites the whole file, so a
// stale parse would make a write invisible.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "../src/config.ts";
import {
  addQuestion,
  answerQuestion,
  dismissQuestion,
  listQuestions,
  sweepExpiredQuestions,
  waitForAnswer,
  formatPushbackAnswerText,
  ASK_TTL_MS,
} from "../src/ask/store.ts";

const realData = PATHS.data;
let dir: string;

/** Backdate a stored row — `addQuestion` always stamps `Date.now()`. */
async function backdate(id: string, createdAt: number): Promise<void> {
  const rows = await listQuestions();
  const next = rows.map((r) => (r.id === id ? { ...r, createdAt } : r));
  await Bun.write(
    join(PATHS.data, "ask", "questions.jsonl"),
    next.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lfg-ask-"));
  await mkdir(join(dir, "ask"), { recursive: true });
  PATHS.data = dir;
});

describe("dismissQuestion", () => {
  test("dismisses an open question and wakes its waiter", async () => {
    const q = await addQuestion({ question: "still needed?", pushback: false });
    const waiting = waitForAnswer(q.id, 5_000);

    const dismissed = await dismissQuestion(q.id);

    expect(dismissed?.status).toBe("dismissed");
    expect((await waiting)?.status).toBe("dismissed");
    expect(await listQuestions("open")).toEqual([]);
    expect((await listQuestions("dismissed")).map((r) => r.id)).toEqual([q.id]);
  });

  test("treats an already-answered question as an idempotent success", async () => {
    const q = await addQuestion({ question: "already answered?" });
    await answerQuestion(q.id, { answer: "yes" });

    expect((await dismissQuestion(q.id))?.status).toBe("answered");
    expect((await listQuestions("answered")).map((r) => r.id)).toEqual([q.id]);
  });

  test("returns null only for an unknown question", async () => {
    expect(await dismissQuestion("missing")).toBeNull();
  });
});

afterEach(async () => {
  PATHS.data = realData;
  await rm(dir, { recursive: true, force: true });
});

describe("read cache", () => {
  test("an out-of-band rewrite of identical byte length is not served stale", async () => {
    const q = await addQuestion({ question: "cached?", pushback: true });
    await listQuestions(); // populate the cache

    // Rewrites the store outside the mutators, keeping the same byte length —
    // the case an mtime+size key alone cannot see.
    await backdate(q.id, q.createdAt - 5_000);

    expect((await listQuestions())[0]?.createdAt).toBe(q.createdAt - 5_000);
  });

  test("a mutation is visible on the very next read", async () => {
    const q = await addQuestion({ question: "answered?", pushback: true });
    await listQuestions(); // populate the cache

    await answerQuestion(q.id, { answer: "yes", via: "web" });

    expect(await listQuestions("open")).toEqual([]);
    expect((await listQuestions("answered")).map((r) => r.id)).toEqual([q.id]);
  });

  test("callers cannot corrupt the cache by mutating what they got back", async () => {
    const first = await addQuestion({ question: "one", pushback: true });
    const rows = await listQuestions();
    rows.push({ ...rows[0], id: "not-persisted" });

    expect((await listQuestions()).map((r) => r.id)).toEqual([first.id]);
  });
});

describe("sweepExpiredQuestions", () => {
  test("expires an open ask older than the TTL", async () => {
    const q = await addQuestion({ question: "merge #917?", pushback: true });
    await backdate(q.id, Date.now() - ASK_TTL_MS - 1_000);

    const expired = await sweepExpiredQuestions();

    expect(expired.map((r) => r.id)).toEqual([q.id]);
    expect(await listQuestions("open")).toEqual([]);
    expect((await listQuestions("expired")).map((r) => r.id)).toEqual([q.id]);
  });

  test("leaves an ask inside the TTL open", async () => {
    const q = await addQuestion({ question: "merge #917?", pushback: true });
    await backdate(q.id, Date.now() - (ASK_TTL_MS - 60_000));

    expect(await sweepExpiredQuestions()).toEqual([]);
    expect((await listQuestions("open")).map((r) => r.id)).toEqual([q.id]);
  });

  test("never touches an already-answered ask, however old", async () => {
    const q = await addQuestion({ question: "merge #917?", pushback: true });
    await answerQuestion(q.id, { answer: "yes", via: "web" });
    await backdate(q.id, Date.now() - ASK_TTL_MS * 10);

    expect(await sweepExpiredQuestions()).toEqual([]);
    expect((await listQuestions("answered")).map((r) => r.id)).toEqual([q.id]);
  });

  test("a no-op sweep does not rewrite the store", async () => {
    const q = await addQuestion({ question: "still fresh?", pushback: true });
    const file = join(PATHS.data, "ask", "questions.jsonl");
    const before = await Bun.file(file).text();

    expect(await sweepExpiredQuestions()).toEqual([]);

    expect(await Bun.file(file).text()).toBe(before);
    expect((await listQuestions("open")).map((r) => r.id)).toEqual([q.id]);
  });

  test("expiring wakes a blocked long-poll instead of hanging it to timeout", async () => {
    const q = await addQuestion({ question: "legacy long-poll", pushback: false });
    await backdate(q.id, Date.now() - ASK_TTL_MS - 1_000);

    const waiting = waitForAnswer(q.id, 5_000);
    await sweepExpiredQuestions();

    const resolved = await waiting;
    expect(resolved?.status).toBe("expired");
  });

  test("sweeps only the stale rows in a mixed store", async () => {
    const stale = await addQuestion({ question: "old", pushback: true });
    const fresh = await addQuestion({ question: "new", pushback: true });
    await backdate(stale.id, Date.now() - ASK_TTL_MS - 1_000);

    const expired = await sweepExpiredQuestions();

    expect(expired.map((r) => r.id)).toEqual([stale.id]);
    expect((await listQuestions("open")).map((r) => r.id)).toEqual([fresh.id]);
  });
});

describe("formatPushbackAnswerText", () => {
  test("puts Their reply on the first line so a head-only delivery still carries the choice", () => {
    const text = formatPushbackAnswerText({
      id: "45bd680b6a2b",
      question:
        "Which path for benny@omg.dev Gmail? A=switch. B=keep both. C=steps only.",
      answer: "B: keep both (second MCP)",
    });
    const firstLine = text.split("\n")[0]!;
    expect(firstLine).toContain("[ask-user answer 45bd680b6a2b]");
    expect(firstLine).toContain("Their reply: B: keep both (second MCP)");
    // Head needle (48 chars) must include the start of the reply label.
    expect(firstLine.slice(0, 48)).toContain("Their reply");
    expect(text).toContain("Question:");
  });

  test("empty answer still emits the label (never silently omits the field)", () => {
    const text = formatPushbackAnswerText({
      id: "deadbeefcafe",
      question: "Ship it?",
      answer: "",
    });
    expect(text.split("\n")[0]).toBe(
      "[ask-user answer deadbeefcafe] Their reply: ",
    );
  });
});
