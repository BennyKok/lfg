import { describe, expect, test } from "bun:test";
import {
  cacheProjectFilter,
  PROJECT_FILTER_STORAGE_KEY,
  readCachedProjectFilter,
} from "../web/src/lib/project-filter";

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("project filter cache", () => {
  test("restores the last selected project instead of showing every folder", () => {
    const storage = memoryStorage({
      [PROJECT_FILTER_STORAGE_KEY]: "lfg",
    });

    expect(readCachedProjectFilter(storage)).toBe("lfg");
  });

  test("persists project selection for every app surface, including embeds", () => {
    const storage = memoryStorage();

    cacheProjectFilter("omg", storage);

    expect(readCachedProjectFilter(storage)).toBe("omg");
  });

  test("falls back to all projects when no selection has been made", () => {
    expect(readCachedProjectFilter(memoryStorage())).toBe("__all");
  });
});
