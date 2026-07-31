import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
let prevHome: string | undefined;

// The module reads HOME at call time via process.env.HOME.
async function mod() {
  return await import("./claude-conversation.ts");
}

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "lfg-conv-"));
  process.env.HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function projectDir(cwd: string): string {
  return join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
}
function writeConversation(cwd: string, id: string, body: string): string {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, body);
  return p;
}

const ID = "5e335e2a-84a4-4aff-b379-65c63ba73ae9";

describe("encodeClaudeCwd", () => {
  test("matches Claude's project dir naming", async () => {
    const { encodeClaudeCwd } = await mod();
    expect(encodeClaudeCwd("/home/dev/lfg-worktrees/lfg-2246d0"))
      .toBe("-home-dev-lfg-worktrees-lfg-2246d0");
    expect(encodeClaudeCwd("/home/dev/repos/vibes")).toBe("-home-dev-repos-vibes");
  });
});

describe("ensureConversationVisibleFrom", () => {
  test("already in the right place is a no-op", async () => {
    const { ensureConversationVisibleFrom } = await mod();
    const cwd = "/home/dev/repos/vibes";
    writeConversation(cwd, ID, '{"a":1}\n');
    expect(ensureConversationVisibleFrom(cwd, ID)).toBe("present");
  });

  // THE REGRESSION: worktree swept, resume falls back to the repo root, and the
  // conversation is stranded under the deleted worktree's project dir.
  test("re-files a conversation stranded under a deleted worktree", async () => {
    const { ensureConversationVisibleFrom, conversationPathFor } = await mod();
    const oldCwd = "/home/dev/lfg-worktrees/lfg-2246d0"; // swept
    const newCwd = "/home/dev/repos/vibes"; // fallback
    writeConversation(oldCwd, ID, '{"turn":"history"}\n');

    // Precondition: invisible from the fallback cwd -> Claude would exit.
    expect(existsSync(conversationPathFor(newCwd, ID))).toBe(false);

    expect(ensureConversationVisibleFrom(newCwd, ID)).toBe("copied");

    const landed = conversationPathFor(newCwd, ID);
    expect(existsSync(landed)).toBe(true);
    expect(readFileSync(landed, "utf8")).toBe('{"turn":"history"}\n');
    // Original is preserved, not moved.
    expect(existsSync(join(projectDir(oldCwd), `${ID}.jsonl`))).toBe(true);
  });

  test("reports missing when no transcript exists anywhere", async () => {
    const { ensureConversationVisibleFrom } = await mod();
    expect(ensureConversationVisibleFrom("/home/dev/repos/vibes", ID)).toBe("missing");
  });

  test("prefers the largest copy over a truncated leftover", async () => {
    const { ensureConversationVisibleFrom, conversationPathFor } = await mod();
    writeConversation("/home/dev/a", ID, "x\n"); // stub
    writeConversation("/home/dev/b", ID, "the real history, much longer\n");
    const target = "/home/dev/repos/vibes";
    expect(ensureConversationVisibleFrom(target, ID)).toBe("copied");
    expect(readFileSync(conversationPathFor(target, ID), "utf8"))
      .toBe("the real history, much longer\n");
  });

  test("is idempotent across repeated resumes", async () => {
    const { ensureConversationVisibleFrom } = await mod();
    writeConversation("/home/dev/lfg-worktrees/gone", ID, '{"turn":1}\n');
    const cwd = "/home/dev/repos/vibes";
    expect(ensureConversationVisibleFrom(cwd, ID)).toBe("copied");
    expect(ensureConversationVisibleFrom(cwd, ID)).toBe("present");
  });

  test("missing projects root does not throw", async () => {
    const { ensureConversationVisibleFrom } = await mod();
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    expect(ensureConversationVisibleFrom("/home/dev/x", ID)).toBe("missing");
  });
});
