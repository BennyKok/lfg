import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindClaudeSessionAccount,
  claudeAccountConfigDir,
  claudeAccountIdForSession,
  connectedClaudeAccounts,
  createClaudeAccount,
  listClaudeAccounts,
  pickClaudeAccountForNewSession,
  removeClaudeAccount,
} from "./claude-accounts.ts";

describe("Claude account registry", () => {
  const originalHome = process.env.HOME;
  const originalStore = process.env.LFG_CLAUDE_ACCOUNTS_PATH;
  let root = "";

  function connect(configDir: string, token: string): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      { mode: 0o600 },
    );
  }

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStore === undefined) delete process.env.LFG_CLAUDE_ACCOUNTS_PATH;
    else process.env.LFG_CLAUDE_ACCOUNTS_PATH = originalStore;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  test("imports the existing Claude login as account 1 and adds isolated accounts", () => {
    root = mkdtempSync(join(tmpdir(), "lfg-claude-accounts-"));
    process.env.HOME = join(root, "home");
    process.env.LFG_CLAUDE_ACCOUNTS_PATH = join(root, "data", "accounts.json");
    connect(join(process.env.HOME, ".claude"), "default-token");

    expect(listClaudeAccounts()).toMatchObject([
      { id: "default", number: 1, label: "Claude 1", connected: true, removable: false },
    ]);

    const second = createClaudeAccount();
    expect(second).toMatchObject({ number: 2, label: "Claude 2", connected: false, removable: true });
    const secondDir = claudeAccountConfigDir(second.id)!;
    connect(secondDir, "second-token");

    expect(connectedClaudeAccounts().map((account) => account.number)).toEqual([1, 2]);
    bindClaudeSessionAccount("session-2", second.id);
    expect(claudeAccountIdForSession("session-2")).toBe(second.id);

    expect(removeClaudeAccount(second.id)).toBe(true);
    expect(existsSync(secondDir)).toBe(false);
    expect(claudeAccountIdForSession("session-2")).toBeNull();
  });

  test("auto picks the account with the most headroom in its tightest window", async () => {
    root = mkdtempSync(join(tmpdir(), "lfg-claude-accounts-"));
    process.env.HOME = join(root, "home");
    process.env.LFG_CLAUDE_ACCOUNTS_PATH = join(root, "data", "accounts.json");
    connect(join(process.env.HOME, ".claude"), "default-token");
    const second = createClaudeAccount();
    connect(claudeAccountConfigDir(second.id)!, "second-token");

    const picked = await pickClaudeAccountForNewSession({
      readCapacity: async (account) =>
        account.id === second.id
          ? { available: true, windows: [{ pct: 35 }, { pct: 40 }] }
          : { available: true, windows: [{ pct: 20 }, { pct: 80 }] },
    });

    expect(picked?.id).toBe(second.id);
  });

  test("explicit account pins bypass capacity routing", async () => {
    root = mkdtempSync(join(tmpdir(), "lfg-claude-accounts-"));
    process.env.HOME = join(root, "home");
    process.env.LFG_CLAUDE_ACCOUNTS_PATH = join(root, "data", "accounts.json");
    connect(join(process.env.HOME, ".claude"), "default-token");
    const second = createClaudeAccount();
    connect(claudeAccountConfigDir(second.id)!, "second-token");
    let reads = 0;

    const picked = await pickClaudeAccountForNewSession({
      explicitAccountId: second.id,
      readCapacity: async () => {
        reads++;
        return { available: true, windows: [{ pct: 100 }] };
      },
    });

    expect(picked?.id).toBe(second.id);
    expect(reads).toBe(0);
  });

  test("auto prefers unknown capacity to a known exhausted account", async () => {
    root = mkdtempSync(join(tmpdir(), "lfg-claude-accounts-"));
    process.env.HOME = join(root, "home");
    process.env.LFG_CLAUDE_ACCOUNTS_PATH = join(root, "data", "accounts.json");
    connect(join(process.env.HOME, ".claude"), "default-token");
    const second = createClaudeAccount();
    connect(claudeAccountConfigDir(second.id)!, "second-token");

    const picked = await pickClaudeAccountForNewSession({
      readCapacity: async (account) => {
        if (account.id === second.id) throw new Error("usage unavailable");
        return { available: true, windows: [{ pct: 100 }, { pct: 45 }] };
      },
    });

    expect(picked?.id).toBe(second.id);
  });

  test("auto breaks equal-capacity ties by stable account number", async () => {
    root = mkdtempSync(join(tmpdir(), "lfg-claude-accounts-"));
    process.env.HOME = join(root, "home");
    process.env.LFG_CLAUDE_ACCOUNTS_PATH = join(root, "data", "accounts.json");
    connect(join(process.env.HOME, ".claude"), "default-token");
    const second = createClaudeAccount();
    connect(claudeAccountConfigDir(second.id)!, "second-token");

    const picked = await pickClaudeAccountForNewSession({
      readCapacity: async () => ({
        available: true,
        windows: [{ pct: 30 }, { pct: 50 }],
      }),
    });

    expect(picked?.id).toBe("default");
  });
});
