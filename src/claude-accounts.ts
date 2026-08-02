import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "./config.ts";
import { claudeOauthToken } from "./claude-creds.ts";

export const DEFAULT_CLAUDE_ACCOUNT_ID = "default";

export type ClaudeAccount = {
  id: string;
  number: number;
  label: string;
  connected: boolean;
  removable: boolean;
  createdAt: number;
};

export type ClaudeAccountCapacity = {
  available: boolean;
  windows?: { pct: number | null }[];
};

export type ClaudeAccountCapacityReader = (
  account: ClaudeAccount,
) => Promise<ClaudeAccountCapacity | null>;

type StoredClaudeAccount = Omit<ClaudeAccount, "connected" | "removable"> & {
  configDir: string;
};

type ClaudeAccountStore = {
  version: 1;
  accounts: StoredClaudeAccount[];
  sessionBindings: Record<string, string>;
};

const emptyStore = (): ClaudeAccountStore => ({
  version: 1,
  accounts: [],
  sessionBindings: {},
});

export function defaultClaudeConfigDir(): string {
  return join(process.env.HOME ?? homedir(), ".claude");
}

function storePath(): string {
  return process.env.LFG_CLAUDE_ACCOUNTS_PATH ?? join(PATHS.data, "claude-accounts.json");
}

function accountsRoot(): string {
  return join(dirname(storePath()), "claude-accounts");
}

function readStore(): ClaudeAccountStore {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<ClaudeAccountStore>;
    return {
      version: 1,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
      sessionBindings:
        parsed.sessionBindings && typeof parsed.sessionBindings === "object"
          ? parsed.sessionBindings
          : {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store: ClaudeAccountStore): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

function defaultAccount(): StoredClaudeAccount {
  return {
    id: DEFAULT_CLAUDE_ACCOUNT_ID,
    number: 1,
    label: "Claude 1",
    configDir: defaultClaudeConfigDir(),
    createdAt: 0,
  };
}

function publicAccount(account: StoredClaudeAccount): ClaudeAccount {
  return {
    id: account.id,
    number: account.number,
    label: account.label,
    connected: claudeOauthToken(account.configDir) !== null,
    removable: account.id !== DEFAULT_CLAUDE_ACCOUNT_ID,
    createdAt: account.createdAt,
  };
}

/** Every known account, including a disconnected custom account that can retry login. */
export function listClaudeAccounts(): ClaudeAccount[] {
  const store = readStore();
  const accounts = [defaultAccount(), ...store.accounts]
    .map(publicAccount)
    .filter((account) => account.id !== DEFAULT_CLAUDE_ACCOUNT_ID || account.connected);
  return accounts.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt);
}

/** Connected accounts in the stable order used by the numbered composer icons. */
export function connectedClaudeAccounts(): ClaudeAccount[] {
  return listClaudeAccounts().filter((account) => account.connected);
}

export function createClaudeAccount(): ClaudeAccount {
  const store = readStore();
  const used = new Set([1, ...store.accounts.map((account) => account.number)]);
  let number = 2;
  while (used.has(number)) number++;
  const id = randomUUID();
  const configDir = join(accountsRoot(), id);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const account: StoredClaudeAccount = {
    id,
    number,
    label: `Claude ${number}`,
    configDir,
    createdAt: Date.now(),
  };
  store.accounts.push(account);
  writeStore(store);
  return publicAccount(account);
}

export function claudeAccountConfigDir(id?: string | null): string | null {
  if (!id || id === DEFAULT_CLAUDE_ACCOUNT_ID) return defaultClaudeConfigDir();
  const account = readStore().accounts.find((entry) => entry.id === id);
  if (!account) return null;
  const root = resolve(accountsRoot());
  const configDir = resolve(account.configDir);
  return configDir.startsWith(`${root}/`) ? configDir : null;
}

export function claudeAccount(id?: string | null): ClaudeAccount | null {
  if (!id || id === DEFAULT_CLAUDE_ACCOUNT_ID) {
    const account = publicAccount(defaultAccount());
    return account.connected ? account : null;
  }
  const stored = readStore().accounts.find((entry) => entry.id === id);
  return stored ? publicAccount(stored) : null;
}

export function resolveClaudeAccount(id?: string | null): ClaudeAccount | null {
  if (id) {
    const account = claudeAccount(id);
    return account?.connected ? account : null;
  }
  return connectedClaudeAccounts()[0] ?? null;
}

type RankedClaudeAccount = {
  account: ClaudeAccount;
  // 0 = measured headroom, 1 = unknown (worth trying), 2 = measured exhausted.
  tier: number;
  peakUtilization: number;
  totalUtilization: number;
};

function rankClaudeAccount(
  account: ClaudeAccount,
  capacity: ClaudeAccountCapacity | null,
): RankedClaudeAccount {
  const percentages = capacity?.available
    ? (capacity.windows ?? [])
        .map((window) => window.pct)
        .filter((pct): pct is number => typeof pct === "number" && Number.isFinite(pct))
        .map((pct) => Math.max(0, Math.min(100, pct)))
    : [];
  if (!percentages.length) {
    return {
      account,
      tier: 1,
      peakUtilization: Number.POSITIVE_INFINITY,
      totalUtilization: Number.POSITIVE_INFINITY,
    };
  }
  const peakUtilization = Math.max(...percentages);
  return {
    account,
    tier: peakUtilization >= 100 ? 2 : 0,
    peakUtilization,
    totalUtilization: percentages.reduce((sum, pct) => sum + pct, 0),
  };
}

/**
 * Resolve the one concrete Claude account a new session will keep for life.
 *
 * An explicit account is authoritative and never touches usage. Auto launches
 * compare every connected account concurrently, preferring the most headroom
 * in its tightest window, then total headroom, then the stable account number.
 * A failed/unknown reading remains a fallback ahead of an account known to be
 * exhausted, so a temporary usage outage cannot make session creation
 * impossible while still avoiding a subscription we know has no capacity.
 */
export async function pickClaudeAccountForNewSession(options: {
  explicitAccountId?: string | null;
  readCapacity: ClaudeAccountCapacityReader;
}): Promise<ClaudeAccount | null> {
  const explicitAccountId = options.explicitAccountId?.trim();
  if (explicitAccountId) return resolveClaudeAccount(explicitAccountId);

  const accounts = connectedClaudeAccounts();
  if (accounts.length <= 1) return accounts[0] ?? null;

  const ranked = await Promise.all(
    accounts.map(async (account) => {
      try {
        return rankClaudeAccount(account, await options.readCapacity(account));
      } catch {
        return rankClaudeAccount(account, null);
      }
    }),
  );
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.peakUtilization - b.peakUtilization ||
      a.totalUtilization - b.totalUtilization ||
      a.account.number - b.account.number ||
      a.account.createdAt - b.account.createdAt,
  );
  return ranked[0]?.account ?? null;
}

export function removeClaudeAccount(id: string): boolean {
  if (!id || id === DEFAULT_CLAUDE_ACCOUNT_ID) return false;
  const store = readStore();
  const index = store.accounts.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  const [account] = store.accounts.splice(index, 1);
  for (const [sessionId, accountId] of Object.entries(store.sessionBindings)) {
    if (accountId === id) delete store.sessionBindings[sessionId];
  }
  writeStore(store);
  const root = resolve(accountsRoot());
  const target = resolve(account.configDir);
  if (target.startsWith(`${root}/`)) rmSync(target, { recursive: true, force: true });
  return true;
}

export function bindClaudeSessionAccount(sessionId: string, accountId: string): void {
  if (!sessionId || !accountId) return;
  const store = readStore();
  store.sessionBindings[sessionId] = accountId;
  writeStore(store);
}

export function claudeAccountIdForSession(sessionId?: string | null): string | null {
  if (!sessionId) return null;
  return readStore().sessionBindings[sessionId] ?? null;
}
