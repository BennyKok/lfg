// Registry of sessions lfg started itself. `tmuxName` is the historical field
// name for the stable managed-runtime key: native TUI agents still own a tmux
// session with that name, while command-file SDK agents are direct processes.
// The file survives a server restart so lfg can reconnect to either lifecycle.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "./config.ts";
import { OMG_CAPABILITY_VERSION } from "./omg-capabilities.ts";

function registryPath(): string {
  return `${PATHS.data}/managed-sessions.json`;
}

function lockPath(): string {
  return `${registryPath()}.lock`;
}

export type ManagedSession = {
  tmuxName: string;
  cwd: string;
  createdAt: number;
  agent?: "claude" | "codex" | "aisdk" | "codex-aisdk" | "opencode" | "grok" | "cursor" | "hermes" | "pi" | "copilot";
  // Stable id shown to clients for lfg-created sessions. For agents that mint a
  // native transcript id later (Claude/Codex CLI, Codex AI-SDK, Grok), this is
  // the durable control-plane id while nativeSessionId records the provider id.
  sessionId?: string;
  nativeSessionId?: string;
  launchState?: "launching" | "running" | "failed";
  launchError?: string;
  model?: string;
  /** Reasoning effort selected for subsequent turns, when the agent supports it. */
  thinkingLevel?: string;
  /** Isolated Claude subscription account pinned when this session launched. */
  claudeAccountId?: string;
  title?: string;
  /** Stable UI project label. Kept because resumed sessions can report a stale cwd. */
  project?: string;
  parentSessionId?: string;
  parentNativeSessionId?: string;
  parentAgent?: string;
  spawnedBy?: "subagent" | "fork" | "finding" | "voice" | string;
  /** LFG agent capability contract/tool catalog present when this process launched. */
  capabilityVersion?: string;
  /** Main repo checkout when cwd is an auto-provisioned worktree. */
  repoRoot?: string;
  worktreeBranch?: string;
  /** Set when boot reconciliation relaunched a process without replaying its turn. */
  interruptedAt?: number;
  recoveredFromBootId?: string;
};

type ManagedRegistry = {
  version: 2;
  sessions: Record<string, ManagedSession>;
  /** Claims outlive live rows so delayed retries cannot replace closed sessions. */
  creationClaims: Record<string, ManagedSession>;
};

export type AddManagedResult =
  | { created: true; session: ManagedSession }
  | { created: false; session: ManagedSession };

let memory: ManagedRegistry | null = null;
let memoryPath: string | null = null;
let memoryFingerprint = "";

function emptyRegistry(): ManagedRegistry {
  return { version: 2, sessions: {}, creationClaims: {} };
}

function creationClaimKey(idempotencyKey: string): string {
  return `claim:${idempotencyKey}`;
}

function parseRegistry(value: unknown): ManagedRegistry {
  if (value && typeof value === "object" && (value as { version?: unknown }).version === 2) {
    const v2 = value as Partial<ManagedRegistry>;
    return {
      version: 2,
      sessions: v2.sessions && typeof v2.sessions === "object" ? v2.sessions : {},
      creationClaims:
        v2.creationClaims && typeof v2.creationClaims === "object" ? v2.creationClaims : {},
    };
  }
  // Version 1 was the session map itself. Upgrade without dropping live rows.
  return {
    version: 2,
    sessions: value && typeof value === "object" ? value as Record<string, ManagedSession> : {},
    creationClaims: {},
  };
}

function fingerprint(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

function readAll(force = false): ManagedRegistry {
  const path = registryPath();
  const currentFingerprint = fingerprint(path);
  if (!force && memory && memoryPath === path && memoryFingerprint === currentFingerprint) {
    return memory;
  }
  try {
    const parsed = parseRegistry(JSON.parse(readFileSync(path, "utf8")));
    memory = parsed;
    memoryPath = path;
    memoryFingerprint = currentFingerprint;
    return parsed;
  } catch {
    // Keep the last valid in-memory roster if another process is between
    // durable writes. Atomic rename makes this exceptional, but preserving the
    // last good view is safer than flashing an empty session list.
    if (memory && memoryPath === path) return memory;
    memory = emptyRegistry();
    memoryPath = path;
    memoryFingerprint = currentFingerprint;
    return memory;
  }
}

function writeAll(all: ManagedRegistry): void {
  const path = registryPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
  try {
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    // Persist the rename itself where the filesystem supports directory fsync.
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {}
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
  memory = all;
  memoryPath = path;
  memoryFingerprint = fingerprint(path);
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function withRegistryLock<T>(fn: () => T): T {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  let fd: number | null = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const candidate = openSync(path, "wx", 0o600);
      try {
        writeFileSync(candidate, String(process.pid));
      } catch (err) {
        closeSync(candidate);
        try {
          unlinkSync(path);
        } catch {}
        throw err;
      }
      fd = candidate;
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      let owner = 0;
      let ageMs = 0;
      try {
        owner = Number(readFileSync(path, "utf8"));
      } catch {}
      try {
        ageMs = Date.now() - statSync(path).mtimeMs;
      } catch {}
      // An empty owner can be the tiny window between another process creating
      // the lock and writing its pid, so only reap a known-dead owner or a lock
      // old enough that no registry mutation could still be using it.
      if ((owner > 0 && !pidAlive(owner)) || ageMs > 30_000) {
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      Atomics.wait(lockWait, 0, 0, 5);
    }
  }
  if (fd == null) throw new Error("managed session registry is busy");
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {}
  }
}

export function listManaged(): ManagedSession[] {
  return Object.values(readAll().sessions).map((row) => ({ ...row }));
}

/** Return the session first committed for a caller-supplied creation key. */
export function getManagedSessionCreation(idempotencyKey: string): ManagedSession | null {
  const claim = readAll().creationClaims[creationClaimKey(idempotencyKey)];
  return claim ? { ...claim } : null;
}

/**
 * Atomically claim an idempotency key and add its managed session. The claim
 * and row share one fsynced rename, so a crash exposes both or neither.
 */
export function addManaged(rec: ManagedSession, idempotencyKey?: string): AddManagedResult {
  return withRegistryLock(() => {
    const current = readAll(true);
    const all: ManagedRegistry = {
      version: 2,
      sessions: { ...current.sessions },
      creationClaims: { ...current.creationClaims },
    };
    const claimKey = idempotencyKey ? creationClaimKey(idempotencyKey) : null;
    const priorClaim = claimKey ? all.creationClaims[claimKey] : null;
    if (priorClaim) return { created: false, session: { ...priorClaim } };

    const identities = new Set(
      [rec.sessionId, rec.nativeSessionId].filter((id): id is string => !!id),
    );
    // A cold/manual resume may use a new runtime name for the same durable
    // conversation. Keep one owner row so later boot reconciliation cannot
    // launch both the stale and current records.
    if (identities.size) {
      for (const [name, existing] of Object.entries(all.sessions)) {
        if (name === rec.tmuxName) continue;
        if ([existing.sessionId, existing.nativeSessionId].some((id) => id && identities.has(id))) {
          delete all.sessions[name];
        }
      }
    }
    const stored = {
      ...rec,
      capabilityVersion: rec.capabilityVersion ?? OMG_CAPABILITY_VERSION,
    };
    all.sessions[rec.tmuxName] = stored;
    if (claimKey) all.creationClaims[claimKey] = stored;
    writeAll(all);
    return { created: true, session: { ...stored } };
  });
}

export function patchManaged(tmuxName: string, patch: Partial<ManagedSession>): void {
  withRegistryLock(() => {
    const current = readAll(true);
    const all: ManagedRegistry = {
      version: 2,
      sessions: { ...current.sessions },
      creationClaims: { ...current.creationClaims },
    };
    const cur = all.sessions[tmuxName];
    if (!cur) return;
    all.sessions[tmuxName] = { ...cur, ...patch };
    writeAll(all);
  });
}

export function removeManaged(tmuxName: string, opts?: { forgetCreation?: boolean }): void {
  withRegistryLock(() => {
    const current = readAll(true);
    const all: ManagedRegistry = {
      version: 2,
      sessions: { ...current.sessions },
      creationClaims: { ...current.creationClaims },
    };
    if (tmuxName in all.sessions) {
      if (opts?.forgetCreation) {
        for (const [key, claim] of Object.entries(all.creationClaims)) {
          if (claim.tmuxName === tmuxName) delete all.creationClaims[key];
        }
      }
      delete all.sessions[tmuxName];
      writeAll(all);
    }
  });
}

// Is this tmux name one we started? `target` may be a full pane target
// (`name:0.0`) or a bare session name — we compare on the session-name segment.
export function isManagedName(target: string | null): boolean {
  if (!target) return false;
  const name = target.split(":")[0];
  return name in readAll().sessions;
}

export function resetManagedRegistryForTests(): void {
  memory = null;
  memoryPath = null;
  memoryFingerprint = "";
  try {
    rmSync(lockPath(), { force: true });
  } catch {}
}
