import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureChatTranscriptCaughtUp, subscribeChatTranscript } from "../src/chat-ingest.ts";
import { deleteTranscriptIndexForPath, indexedMessagePage } from "../src/transcript-index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function transcriptLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: role,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    message: { role, content: text },
  });
}

const sid = randomUUID();
const path = join(tmpdir(), `lfg-chat-ingest-smoke-${process.pid}-${Date.now()}.jsonl`);
const subscriberCount = 32;
const unsubs: Array<() => void> = [];

try {
  mkdirSync(dirname(path), { recursive: true });
  deleteTranscriptIndexForPath(path);

  appendFileSync(path, `${transcriptLine("user", "cold hello")}\n`);
  const cold = await ensureChatTranscriptCaughtUp(path, sid, "smoke-cold");
  assert(cold.lines === 1, `expected one cold line, got ${cold.lines}`);

  const pageAfterCold = await indexedMessagePage(path, sid, { limit: 10 });
  assert(pageAfterCold.messages.length === 1, `expected one message after cold import, got ${pageAfterCold.messages.length}`);

  const idle = await ensureChatTranscriptCaughtUp(path, sid, "smoke-idle");
  assert(idle.unchanged, "expected idle no-change tick to skip reads");

  const partial = transcriptLine("assistant", "partial append");
  appendFileSync(path, partial.slice(0, Math.floor(partial.length / 2)));
  const incomplete = await ensureChatTranscriptCaughtUp(path, sid, "smoke-partial");
  assert(incomplete.lines === 0, `expected incomplete line to stay buffered, got ${incomplete.lines}`);

  appendFileSync(path, `${partial.slice(Math.floor(partial.length / 2))}\n`);
  const append = await ensureChatTranscriptCaughtUp(path, sid, "smoke-append");
  assert(append.lines === 1, `expected completed append line, got ${append.lines}`);

  let deliveries = 0;
  for (let i = 0; i < subscriberCount; i++) {
    unsubs.push(subscribeChatTranscript(path, sid, (event) => {
      deliveries += event.messages.filter((message) => message.text === "fanout append").length;
    }));
  }

  await ensureChatTranscriptCaughtUp(path, sid, "smoke-subscriber-baseline");
  appendFileSync(path, `${transcriptLine("assistant", "fanout append")}\n`);
  const fanout = await ensureChatTranscriptCaughtUp(path, sid, "smoke-fanout");
  assert(fanout.lines === 1, `expected one fanout line, got ${fanout.lines}`);
  assert(deliveries === subscriberCount, `expected ${subscriberCount} subscriber deliveries, got ${deliveries}`);

  const finalPage = await indexedMessagePage(path, sid, { limit: 10 });
  assert(finalPage.total === 3, `expected three persisted messages without duplicates, got ${finalPage.total}`);
  assert(finalPage.messages.map((message) => message.text).join("|") === "cold hello|partial append|fanout append", "unexpected final message order");

  console.log(JSON.stringify({
    ok: true,
    sid,
    cold,
    idle,
    append,
    fanout,
    deliveries,
    total: finalPage.total,
  }));
} finally {
  for (const unsub of unsubs) unsub();
  deleteTranscriptIndexForPath(path);
  rmSync(path, { force: true });
}
