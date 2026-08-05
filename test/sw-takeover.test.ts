import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The service worker's one non-negotiable duty: replace whatever worker came
 * before it.
 *
 * A stale worker with a fetch handler answers navigations from its own cache,
 * so the installed app never requests the page and never runs any of our
 * JavaScript — a black window that cannot be fixed from inside the page. If
 * install or activate can be derailed by a failing Cache API (iOS storage
 * pressure, an evicted bucket, quota errors), the old worker stays in charge
 * permanently and the browser refetches sw.js forever. That is a real failure
 * we observed on a device, not a hypothetical.
 *
 * These tests run the real sw.js against a Cache API that rejects everything.
 */
const SW_SOURCE = readFileSync(
  join(import.meta.dir, "..", "web", "public", "sw.js"),
  "utf8",
);

type Harness = {
  fire: (type: string) => Promise<PromiseSettledResult<unknown>[]>;
  calls: { skipWaiting: number; claim: number };
};

function loadWorker(caches: unknown): Harness {
  const handlers = new Map<string, (event: unknown) => void>();
  const calls = { skipWaiting: 0, claim: 0 };

  const selfStub = {
    addEventListener(type: string, handler: (event: unknown) => void) {
      handlers.set(type, handler);
    },
    skipWaiting() {
      calls.skipWaiting++;
      return Promise.resolve();
    },
    clients: {
      claim() {
        calls.claim++;
        return Promise.resolve();
      },
      matchAll: async () => [],
    },
    registration: { unregister: async () => true, getNotifications: async () => [] },
    navigator: {},
  };

  // eslint-disable-next-line no-new-func
  const run = new Function("self", "caches", "fetch", SW_SOURCE);
  run(selfStub, caches, async () => ({ ok: false }));

  return {
    calls,
    async fire(type: string) {
      const waited: unknown[] = [];
      const handler = handlers.get(type);
      if (!handler) throw new Error(`sw.js registered no ${type} handler`);
      handler({ waitUntil: (p: unknown) => waited.push(p) });
      return Promise.allSettled(waited);
    },
  };
}

const hostileCaches = {
  keys: async () => {
    throw new Error("QuotaExceededError");
  },
  open: async () => {
    throw new Error("QuotaExceededError");
  },
  delete: async () => {
    throw new Error("QuotaExceededError");
  },
  match: async () => undefined,
};

const workingCaches = () => {
  const store = new Set<string>(["lfg-shell-old", "lfg-assets-old"]);
  return {
    keys: async () => [...store],
    open: async (k: string) => {
      store.add(k);
      return {};
    },
    delete: async (k: string) => store.delete(k),
    match: async () => undefined,
  };
};

describe("install", () => {
  test("hands over control before touching the cache", async () => {
    // Ordering matters: skipWaiting must already have run by the time the
    // waitUntil work is even awaited.
    const sw = loadWorker(hostileCaches);
    const results = await sw.fire("install");
    expect(sw.calls.skipWaiting).toBe(1);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  test("still installs when the whole Cache API is broken", async () => {
    const sw = loadWorker(hostileCaches);
    const results = await sw.fire("install");
    // A rejected waitUntil is what kills the install and strands the old worker.
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
  });

  test("normal path is unaffected", async () => {
    const sw = loadWorker(workingCaches());
    const results = await sw.fire("install");
    expect(sw.calls.skipWaiting).toBe(1);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("activate", () => {
  test("claims clients even when cache cleanup throws", async () => {
    const sw = loadWorker(hostileCaches);
    const results = await sw.fire("activate");
    expect(sw.calls.claim).toBe(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
  });

  test("normal path still claims", async () => {
    const sw = loadWorker(workingCaches());
    await sw.fire("activate");
    expect(sw.calls.claim).toBe(1);
  });
});

test("the worker has no fetch handler", () => {
  // A fetch handler is what let a stale worker answer navigations from cache.
  expect(SW_SOURCE).not.toMatch(/addEventListener\(\s*["']fetch["']/);
});
