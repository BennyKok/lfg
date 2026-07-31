import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readNewCmdLines,
  initialCmdOffset,
  readCursor,
  writeCursor,
  removeCursor,
  cursorPath,
} from "./cmd-tail.ts";

let dir: string;
let cmdFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfg-cmdtail-"));
  cmdFile = join(dir, "session.cmd");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function append(cmd: unknown): void {
  appendFileSync(cmdFile, JSON.stringify(cmd) + "\n");
}
function send(text: string) {
  return { type: "send", text };
}

describe("readNewCmdLines", () => {
  test("reads appended lines and advances the cursor", () => {
    append(send("one"));
    append(send("two"));
    const r = readNewCmdLines(cmdFile, 0);
    expect(r.lines.map((l) => JSON.parse(l).text)).toEqual(["one", "two"]);
    expect(r.offset).toBe(statSync(cmdFile).size);

    // Nothing new -> no lines, same offset.
    const r2 = readNewCmdLines(cmdFile, r.offset);
    expect(r2.lines).toEqual([]);
    expect(r2.offset).toBe(r.offset);

    append(send("three"));
    const r3 = readNewCmdLines(cmdFile, r2.offset);
    expect(r3.lines.map((l) => JSON.parse(l).text)).toEqual(["three"]);
  });

  test("missing file is a no-op, not a rewind", () => {
    const r = readNewCmdLines(join(dir, "absent.cmd"), 512);
    expect(r.lines).toEqual([]);
    expect(r.offset).toBe(512);
  });

  // THE REGRESSION. Multi-byte content made statSync().size (bytes) exceed
  // readFileSync(...,"utf8").length (UTF-16 units); the old loop read that as a
  // truncation, reset to 0 and replayed the whole command history.
  test("multi-byte history does not rewind the cursor", () => {
    append(send("Let me know when we are ready — the credentials…"));
    append(send("What do you need? Um… is there a native extension →"));
    append(send("§ status check"));

    const bytes = statSync(cmdFile).size;
    const utf16 = require("node:fs").readFileSync(cmdFile, "utf8").length;
    // Precondition: this file is exactly the shape that triggered the bug.
    expect(bytes).toBeGreaterThan(utf16);

    // A harness seeded at end-of-file must see nothing further, not a replay.
    const r = readNewCmdLines(cmdFile, bytes);
    expect(r.lines).toEqual([]);
    expect(r.offset).toBe(bytes);
  });

  test("real-world shape: 17 multi-byte commands replay zero times across many polls", () => {
    for (let i = 0; i < 17; i++) append(send(`msg ${i} — with … punctuation →`));
    let offset = initialCmdOffset(cmdFile);
    const delivered: string[] = [];
    for (let tick = 0; tick < 10; tick++) {
      const r = readNewCmdLines(cmdFile, offset);
      offset = r.offset;
      delivered.push(...r.lines);
    }
    expect(delivered).toEqual([]);
  });

  test("genuine truncation rewinds to 0", () => {
    append(send("old"));
    writeFileSync(cmdFile, ""); // rotated
    append(send("fresh"));
    const r = readNewCmdLines(cmdFile, 9999);
    expect(r.lines.map((l) => JSON.parse(l).text)).toEqual(["fresh"]);
  });

  test("a torn append is not consumed until its newline lands", () => {
    append(send("complete"));
    const afterComplete = statSync(cmdFile).size;
    appendFileSync(cmdFile, '{"type":"send","text":"partial'); // no newline yet

    const r = readNewCmdLines(cmdFile, 0);
    expect(r.lines.map((l) => JSON.parse(l).text)).toEqual(["complete"]);
    expect(r.offset).toBe(afterComplete);

    appendFileSync(cmdFile, '"}\n'); // the rest arrives
    const r2 = readNewCmdLines(cmdFile, r.offset);
    expect(r2.lines.map((l) => JSON.parse(l).text)).toEqual(["partial"]);
  });

  test("slices multi-byte lines on exact character boundaries", () => {
    append(send("héllo — wörld"));
    append(send("→ ok"));
    const first = readNewCmdLines(cmdFile, 0);
    expect(first.lines.map((l) => JSON.parse(l).text)).toEqual(["héllo — wörld", "→ ok"]);
    // Reading from a mid-file byte offset must still decode cleanly.
    append(send("ünïcode ✓"));
    const second = readNewCmdLines(cmdFile, first.offset);
    expect(second.lines.map((l) => JSON.parse(l).text)).toEqual(["ünïcode ✓"]);
  });
});

describe("initialCmdOffset", () => {
  test("with no cursor, seeds to end of file (no history replay)", () => {
    append(send("history"));
    expect(initialCmdOffset(cmdFile)).toBe(statSync(cmdFile).size);
  });

  test("absent file starts at 0", () => {
    expect(initialCmdOffset(join(dir, "absent.cmd"))).toBe(0);
  });

  // The crash-survival property the durable cursor buys us.
  test("a persisted cursor delivers the backlog queued while the harness was down", () => {
    append(send("delivered before crash"));
    const consumed = readNewCmdLines(cmdFile, 0);
    writeCursor(cmdFile, consumed.offset);

    // Server down; user keeps sending.
    append(send("sent while down"));

    // Harness restarts.
    const offset = initialCmdOffset(cmdFile);
    const r = readNewCmdLines(cmdFile, offset);
    expect(r.lines.map((l) => JSON.parse(l).text)).toEqual(["sent while down"]);
  });

  test("a cursor past end-of-file (rotation) restarts from 0", () => {
    append(send("only line"));
    writeCursor(cmdFile, 10_000);
    expect(initialCmdOffset(cmdFile)).toBe(0);
  });
});

describe("cursor persistence", () => {
  test("round-trips and survives removal", () => {
    expect(readCursor(cmdFile)).toBeNull();
    writeCursor(cmdFile, 1234);
    expect(readCursor(cmdFile)).toBe(1234);
    removeCursor(cmdFile);
    expect(readCursor(cmdFile)).toBeNull();
  });

  test("a corrupt cursor file is ignored rather than rewinding", () => {
    append(send("history"));
    writeFileSync(cursorPath(cmdFile), "not-a-number");
    expect(readCursor(cmdFile)).toBeNull();
    // Falls back to end-of-file, so no replay.
    expect(initialCmdOffset(cmdFile)).toBe(statSync(cmdFile).size);
  });

  test("a negative cursor is rejected", () => {
    writeFileSync(cursorPath(cmdFile), "-5");
    expect(readCursor(cmdFile)).toBeNull();
  });
});
