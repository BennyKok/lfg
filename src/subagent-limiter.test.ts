import { describe, expect, test } from "bun:test";
import { maxConcurrentAgents, SubagentLimiter } from "./subagent-limiter.ts";

describe("subagent concurrency limiter", () => {
  test("uses a conservative default and validates overrides", () => {
    expect(maxConcurrentAgents({} as NodeJS.ProcessEnv)).toBe(6);
    expect(maxConcurrentAgents({ LFG_MAX_CONCURRENT_AGENTS: "2" } as NodeJS.ProcessEnv)).toBe(2);
    expect(maxConcurrentAgents({ LFG_MAX_CONCURRENT_AGENTS: "0" } as NodeJS.ProcessEnv)).toBe(6);
    expect(maxConcurrentAgents({ LFG_MAX_CONCURRENT_AGENTS: "20" } as NodeJS.ProcessEnv)).toBe(6);
  });

  test("queues beyond the cap and admits in FIFO order", async () => {
    const limiter = new SubagentLimiter(2);
    await limiter.acquire("one");
    await limiter.acquire("two");
    let admitted = false;
    const third = limiter.acquire("three").then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(limiter.snapshot().queued).toEqual(["three"]);
    limiter.release("one");
    await third;
    expect(limiter.snapshot().active).toEqual(["two", "three"]);
  });

  test("reaps vanished restored sessions", () => {
    const limiter = new SubagentLimiter(2);
    limiter.restore(["gone", "alive"]);
    limiter.reconcile((name) => name === "alive");
    expect(limiter.snapshot().active).toEqual(["alive"]);
  });

  test("restores over-cap legacy sessions without admitting more", async () => {
    const limiter = new SubagentLimiter(2);
    limiter.restore(["one", "two", "legacy-extra"]);
    let admitted = false;
    void limiter.acquire("queued").then(() => { admitted = true; });
    limiter.release("one");
    await Promise.resolve();
    expect(admitted).toBe(false);
    limiter.release("two");
    await Promise.resolve();
    expect(admitted).toBe(true);
  });

  test("updates capacity at runtime and drains queued work", async () => {
    const limiter = new SubagentLimiter(1);
    await limiter.acquire("one");
    let admitted = false;
    const second = limiter.acquire("two").then(() => { admitted = true; });
    limiter.setMax(2);
    await second;
    expect(admitted).toBe(true);
    expect(limiter.snapshot().max).toBe(2);
  });
});
