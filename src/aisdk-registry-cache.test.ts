// Building the session list walks the aisdk registry about eight times per
// rebuild — several direct listEntries() calls plus findEntryByAnyId, which
// scans the whole directory per lookup. With ~90 live sessions that was ~700
// reads and ~700 JSON.parse calls per rebuild, and it profiled as 60% of the
// rebuild's CPU — more than every process and tmux scan combined.
//
// These tests pin the cache that fixes it, and the invalidation that keeps it
// honest: entries are written by the harness processes, not just by us, so a
// cache that trusted a clock instead of the file's mtime could serve a busy
// flag another process had already flipped.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { cmdPath, listEntries, readEntry, removeEntry, writeEntry, type AisdkEntry } from "./aisdk-registry.ts";

const written: string[] = [];

function entry(sessionId: string, over: Partial<AisdkEntry> = {}): AisdkEntry {
  return {
    sessionId,
    cwd: "/tmp/cache-test",
    model: "opus",
    harnessPid: process.pid,
    createdAt: 1,
    ...over,
  } as AisdkEntry;
}

function write(e: AisdkEntry): void {
  writeEntry(e);
  written.push(e.sessionId);
}

// Count only the parses of OUR entries: the registry directory is shared with
// whatever else this box is running.
function countingParses<T>(marker: string, fn: () => T): { value: T; parses: number } {
  const original = JSON.parse;
  let parses = 0;
  (JSON as { parse: typeof JSON.parse }).parse = ((text: string, ...rest: unknown[]) => {
    if (typeof text === "string" && text.includes(marker)) parses++;
    return (original as (t: string, ...r: unknown[]) => unknown)(text, ...rest);
  }) as typeof JSON.parse;
  try {
    return { value: fn(), parses };
  } finally {
    (JSON as { parse: typeof JSON.parse }).parse = original;
  }
}

afterEach(() => {
  for (const id of written.splice(0)) {
    rmSync(`${cmdPath(id).replace(/\.cmd$/, ".json")}`, { force: true });
    rmSync(cmdPath(id), { force: true });
  }
});

describe("aisdk registry entry cache", () => {
  test("parses an unchanged entry once, however many times it is listed", () => {
    const id = `cache-a-${crypto.randomUUID()}`;
    write(entry(id));
    listEntries(); // warm

    const { parses } = countingParses(id, () => {
      listEntries();
      listEntries();
      readEntry(id);
    });
    expect(parses).toBe(0);
  });

  test("re-reads an entry after it changes on disk", () => {
    const id = `cache-b-${crypto.randomUUID()}`;
    write(entry(id, { model: "opus" }));
    expect(readEntry(id)?.model).toBe("opus");

    write(entry(id, { model: "sonnet" }));
    expect(readEntry(id)?.model).toBe("sonnet");
    expect(listEntries().find((e) => e.sessionId === id)?.model).toBe("sonnet");
  });

  test("forgets an entry this process removed, immediately", () => {
    const id = `cache-c-${crypto.randomUUID()}`;
    write(entry(id));
    expect(listEntries().some((e) => e.sessionId === id)).toBe(true);

    removeEntry(id);
    expect(listEntries().some((e) => e.sessionId === id)).toBe(false);
    expect(readEntry(id)).toBeNull();
  });

  test("picks up another process's delete on the next window, not later", async () => {
    const id = `cache-d-${crypto.randomUUID()}`;
    write(entry(id));
    expect(listEntries().some((e) => e.sessionId === id)).toBe(true);

    // Deleted behind our back, the way a harness on another process does it.
    rmSync(`${cmdPath(id).replace(/\.cmd$/, ".json")}`, { force: true });
    // readEntry always stats, so it is never behind.
    expect(readEntry(id)).toBeNull();
    // The listing collapses a burst of walks, so it can be one window stale —
    // and no staler. Everything that polls this runs far slower than that.
    await Bun.sleep(60);
    expect(listEntries().some((e) => e.sessionId === id)).toBe(false);
  });
});
