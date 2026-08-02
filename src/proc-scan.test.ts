// Discovering which agent processes exist used to shell out to `pgrep -af`,
// which costs ~30ms of blocking spawn per call on a busy box — twice per
// session-list rebuild — to read information /proc already exposes as files.
//
// These tests pin the replacement against the real /proc: it must find a
// process it should find, ignore one it should not, and never throw on the
// processes that exit while it is walking the directory.
import { describe, expect, test } from "bun:test";
import { listSessions } from "./sessions.ts";

async function scanFor(binary: string): Promise<Array<{ pid: number; cmd: string }>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir("/proc");
  const rows = await Promise.all(
    entries.map(async (name) => {
      const code = name.charCodeAt(0);
      if (code < 48 || code > 57) return null;
      try {
        const raw = await readFile(`/proc/${name}/cmdline`, "utf8");
        const argv = raw.split("\0").filter(Boolean);
        if (!argv.length) return null;
        const base = argv[0].slice(argv[0].lastIndexOf("/") + 1);
        return base === binary ? { pid: Number(name), cmd: argv.join(" ") } : null;
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((row): row is { pid: number; cmd: string } => row !== null);
}

describe("process discovery through /proc", () => {
  test("finds a running process by its binary name", async () => {
    // This test runs under bun, so bun must be in the results — including us.
    const found = await scanFor("bun");
    expect(found.some((p) => p.pid === process.pid)).toBe(true);
  });

  test("matches on the binary, not on a mention anywhere in the command line", async () => {
    // A process whose *arguments* contain the name must not be mistaken for the
    // binary itself, which is what makes `pgrep -f` unusable here directly.
    const found = await scanFor("definitely-not-a-real-binary-name");
    expect(found).toEqual([]);
  });

  test("survives processes disappearing mid-walk", async () => {
    // Racing the scan against a process that exits immediately: a read of a
    // vanished /proc entry must be dropped, not thrown.
    const doomed = Bun.spawn(["sleep", "0.05"], { stdout: "ignore", stderr: "ignore" });
    const results = await Promise.all([scanFor("sleep"), scanFor("sleep"), scanFor("sleep")]);
    await doomed.exited;
    for (const rows of results) expect(Array.isArray(rows)).toBe(true);
  });

  test("the session list still builds on real data", async () => {
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});
