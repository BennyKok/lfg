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
import { LFG_CAPABILITY_VERSION } from "./lfg-capabilities.ts";

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

let memory: Record<string, ManagedSession> | null = null;
let memoryPath: string | null = null;
let memoryFingerprint = "";

function fingerprint(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

function readAll(force = false): Record<string, ManagedSession> {
  const path = registryPath();
  const currentFingerprint = fingerprint(path);
  if (!force && memory && memoryPath === path && memoryFingerprint === currentFingerprint) {
    return memory;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, ManagedSession>;
    memory = parsed;
    memoryPath = path;
    memoryFingerprint = currentFingerprint;
    return parsed;
  } catch {
    // Keep the last valid in-memory roster if another process is between
    // durable writes. Atomic rename makes this exceptional, but preserving the
    // last good view is safer than flashing an empty session list.
    if (memory && memoryPath === path) return memory;
    memory = {};
    memoryPath = path;
    memoryFingerprint = currentFingerprint;
    return memory;
  }
}

function writeAll(all: Record<string, ManagedSession>): void {
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
  return Object.values(readAll()).map((row) => ({ ...row }));
}

export function addManaged(rec: ManagedSession): void {
  withRegistryLock(() => {
    const all = { ...readAll(true) };
    const identities = new Set(
      [rec.sessionId, rec.nativeSessionId].filter((id): id is string => !!id),
    );
    // A cold/manual resume may use a new runtime name for the same durable
    // conversation. Keep one owner row so later boot reconciliation cannot
    // launch both the stale and current records.
    if (identities.size) {
      for (const [name, existing] of Object.entries(all)) {
        if (name === rec.tmuxName) continue;
        if ([existing.sessionId, existing.nativeSessionId].some((id) => id && identities.has(id))) {
          delete all[name];
        }
      }
    }
    all[rec.tmuxName] = {
      ...rec,
      capabilityVersion: rec.capabilityVersion ?? LFG_CAPABILITY_VERSION,
    };
    writeAll(all);
  });
}

export function patchManaged(tmuxName: string, patch: Partial<ManagedSession>): void {
  withRegistryLock(() => {
    const all = { ...readAll(true) };
    const cur = all[tmuxName];
    if (!cur) return;
    all[tmuxName] = { ...cur, ...patch };
    writeAll(all);
  });
}

export function removeManaged(tmuxName: string): void {
  withRegistryLock(() => {
    const all = { ...readAll(true) };
    if (tmuxName in all) {
      delete all[tmuxName];
      writeAll(all);
    }
  });
}

// Is this tmux name one we started? `target` may be a full pane target
// (`name:0.0`) or a bare session name — we compare on the session-name segment.
export function isManagedName(target: string | null): boolean {
  if (!target) return false;
  const name = target.split(":")[0];
  return name in readAll();
}

export function resetManagedRegistryForTests(): void {
  memory = null;
  memoryPath = null;
  memoryFingerprint = "";
  try {
    rmSync(lockPath(), { force: true });
  } catch {}
}
