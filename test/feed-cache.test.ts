import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearFeedCache,
  readFeedCache,
  updateFeedCache,
  writeFeedCache,
} from "../web/src/lib/feed-cache.ts";

describe("feed cache", () => {
  beforeEach(() => clearFeedCache());

  test("round-trips a written page so a revisit can paint instantly", () => {
    writeFeedCache("shipped:feed", [{ id: "a" }, { id: "b" }], 2);
    const entry = readFeedCache<{ id: string }>("shipped:feed");
    expect(entry?.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(entry?.total).toBe(2);
  });

  test("misses cleanly for an unknown key", () => {
    expect(readFeedCache("nope")).toBeNull();
  });

  test("updates keep the cached page current after mutations", () => {
    writeFeedCache("artifacts:html", [{ id: "a" }, { id: "b" }], 2);
    updateFeedCache<{ id: string }>("artifacts:html", (prev) => {
      if (!prev) return null;
      return {
        items: prev.items.filter((item) => item.id !== "a"),
        total: prev.total - 1,
        at: Date.now(),
      };
    });
    expect(readFeedCache<{ id: string }>("artifacts:html")?.items.map((item) => item.id)).toEqual([
      "b",
    ]);
    expect(readFeedCache("artifacts:html")?.total).toBe(1);
  });

  test("clear drops one key or the whole cache", () => {
    writeFeedCache("a", [1], 1);
    writeFeedCache("b", [2], 1);
    clearFeedCache("a");
    expect(readFeedCache("a")).toBeNull();
    expect(readFeedCache("b")?.items).toEqual([2]);
    clearFeedCache();
    expect(readFeedCache("b")).toBeNull();
  });
});
