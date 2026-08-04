import { describe, expect, test } from "bun:test";
import { createSessionListCache } from "./session-cache.ts";
import type { Session } from "./sessions.ts";

// The scan is the expensive process+transcript walk the cache exists to
// amortize. A controllable stand-in lets each test decide exactly when a scan
// starts and when it finishes, which is the whole subject here: what the cache
// does with a scan that straddles a mutation.
function harness() {
  const scans: { resolve: (sessions: Session[]) => void }[] = [];
  const cache = createSessionListCache(
    () => new Promise<Session[]>((resolve) => scans.push({ resolve })),
  );
  return { cache, scans };
}

function row(sessionId: string): Session {
  return { sessionId, title: sessionId } as unknown as Session;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("session list cache invalidation", () => {
  test("a scan that started before an invalidate is not served as current", async () => {
    const { cache, scans } = harness();
    // The warm-refresh timer starts a scan...
    const first = cache.get();
    await settle();
    expect(scans.length).toBe(1);

    // ...then a session is created, which invalidates the cache. The in-flight
    // scan cannot possibly know about it.
    cache.invalidate();

    // The client's post-create refresh must NOT be handed that pre-create scan.
    const afterCreate = cache.get();
    await settle();
    expect(scans.length).toBe(2);

    scans[0]!.resolve([row("old")]);
    scans[1]!.resolve([row("old"), row("new")]);

    expect((await first).map((s) => s.sessionId)).toEqual(["old"]);
    expect((await afterCreate).map((s) => s.sessionId)).toEqual(["old", "new"]);
  });

  test("a stale scan does not install itself as the cached list", async () => {
    const { cache, scans } = harness();
    const stale = cache.get();
    await settle();
    cache.invalidate();
    const fresh = cache.get();
    await settle();

    // The fresh scan finishes FIRST; the stale one lands afterwards and must
    // not overwrite it.
    scans[1]!.resolve([row("old"), row("new")]);
    await fresh;
    scans[0]!.resolve([row("old")]);
    await stale;
    await settle();

    const next = cache.get();
    await settle();
    expect(scans.length).toBe(2); // served from cache, no third scan
    expect((await next).map((s) => s.sessionId)).toEqual(["old", "new"]);
  });

  test("concurrent readers within one epoch share a single scan", async () => {
    const { cache, scans } = harness();
    const a = cache.get();
    const b = cache.get();
    await settle();
    expect(scans.length).toBe(1);
    scans[0]!.resolve([row("one")]);
    expect(await a).toEqual(await b);
  });

  test("the cache is timestamped from when the scan started, not when it ended", async () => {
    // A scan on a loaded box can take longer than the 3s TTL. Stamping it at
    // completion credited it with freshness it never had, so a view of the
    // world as it was 4s ago was served as current for another 3s — part of why
    // a just-created session could stay invisible for more than five seconds.
    const { cache, scans } = harness();
    const slow = cache.get();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    scans[0]!.resolve([row("one")]);
    await slow;
    await settle();

    // Its data is already older than the TTL, so the next read must rescan
    // rather than serve it.
    void cache.get();
    await settle();
    expect(scans.length).toBe(2);
  }, 10_000);
});
