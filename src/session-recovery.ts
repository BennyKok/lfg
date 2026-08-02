import {
  currentBootId,
  isPidAlive,
  listEntries,
  patchEntry,
  type AisdkEntry,
} from "./aisdk-registry.ts";
import { addManaged, listManaged, patchManaged, type ManagedSession } from "./managed.ts";
import {
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedOpencodeAisdkSession,
  spawnManagedPiSession,
  tmuxHasSession,
  type ManagedHarnessSpawnResult,
} from "./tmux.ts";
import { userAssignments } from "./users.ts";

export type RecoveryResult = {
  bootId: string | null;
  adopted: number;
  recovered: number;
  failed: number;
  skippedLegacy: number;
};

function matchingManaged(entry: AisdkEntry, managed: ManagedSession[]): ManagedSession | null {
  return managed.find((row) => row.tmuxName === entry.tmuxName) ??
    managed.find((row) =>
      row.sessionId === entry.sessionId ||
      row.nativeSessionId === entry.sessionId ||
      (!!entry.threadId && (row.sessionId === entry.threadId || row.nativeSessionId === entry.threadId))
    ) ?? null;
}

function launchRecovered(
  entry: AisdkEntry,
  managed: ManagedSession,
  recoveredAt: number,
  assignedUser: string | null,
): ManagedHarnessSpawnResult {
  const common = {
    name: managed.tmuxName,
    cwd: managed.cwd || entry.cwd,
    model: managed.model || entry.model,
    lfgSessionId: managed.sessionId || entry.sessionId,
    lfgUser: assignedUser,
    recoveredAt,
  };
  if (entry.agent === "codex") {
    if (!entry.threadId) return { ok: false, error: "codex recovery handle missing" };
    return spawnManagedCodexAisdkSession({
      ...common,
      key: entry.sessionId,
      resume: entry.threadId,
      thinkingLevel: entry.thinkingLevel ?? undefined,
    });
  }
  if (entry.agent === "opencode") {
    if (!entry.threadId) return { ok: false, error: "opencode recovery handle missing" };
    return spawnManagedOpencodeAisdkSession({
      ...common,
      key: entry.sessionId,
      resume: entry.threadId,
    });
  }
  if (entry.agent === "pi") {
    if (!entry.threadId) return { ok: false, error: "pi recovery handle missing" };
    return spawnManagedPiSession({
      ...common,
      key: entry.sessionId,
      resume: entry.threadId,
      thinkingLevel: entry.thinkingLevel ?? undefined,
    });
  }
  return spawnManagedAisdkSession({
    ...common,
    sessionId: entry.sessionId,
    thinkingLevel: entry.thinkingLevel ?? undefined,
    claudeAccountId: managed.claudeAccountId,
  });
}

// Reconcile only durable SDK harnesses. A provider turn is never replayed:
// recovery reopens the conversation at an idle boundary and marks it as
// interrupted so the human can inspect the transcript before continuing.
export async function reconcileCommandFileSessions(
  log: (line: string) => void = console.log,
): Promise<RecoveryResult> {
  const bootId = currentBootId();
  const result: RecoveryResult = { bootId, adopted: 0, recovered: 0, failed: 0, skippedLegacy: 0 };
  if (!bootId) return result;
  const managed = listManaged();
  const assignments = userAssignments();

  for (const entry of listEntries()) {
    const owner = matchingManaged(entry, managed);
    if (!owner) continue;
    const legacyTmuxAlive = !entry.bootId && tmuxHasSession(entry.tmuxName);
    // PIDs are only meaningful within the boot that recorded them. After a
    // reboot Linux may reuse the number for an unrelated process, so a stale
    // prior-boot PID must never suppress recovery.
    if (isPidAlive(entry.harnessPid) && (entry.bootId === bootId || legacyTmuxAlive)) {
      // Adopt legacy tmux-wrapped harnesses into the boot journal. They keep
      // running until naturally closed; all newly launched harnesses are direct.
      patchEntry(entry.sessionId, {
        bootId,
        supervisor: entry.supervisor ?? (tmuxHasSession(entry.tmuxName) ? "tmux" : "process"),
        recoveryClaimBootId: null,
      });
      addManaged(owner); // also removes stale duplicate owner rows
      result.adopted++;
      continue;
    }
    // Entries created before boot journaling are safe to show in Recent and
    // manually resume, but not safe to auto-launch: we cannot prove which boot
    // or runtime owned them.
    if (!entry.bootId) {
      result.skippedLegacy++;
      continue;
    }
    if (entry.recoveryClaimBootId === bootId) continue;

    const recoveredAt = Date.now();
    patchEntry(entry.sessionId, { recoveryClaimBootId: bootId, recoveredAt });
    const assignedUser = assignments[owner.tmuxName] ?? null;
    const launched = launchRecovered(entry, owner, recoveredAt, assignedUser);
    if (!launched.ok) {
      patchManaged(owner.tmuxName, {
        launchState: "failed",
        launchError: launched.error || "recovery launch failed",
        interruptedAt: recoveredAt,
        recoveredFromBootId: entry.bootId,
      });
      log(`[session-recovery] failed ${entry.sessionId.slice(0, 8)}: ${launched.error || "launch failed"}`);
      result.failed++;
      continue;
    }
    patchManaged(owner.tmuxName, {
      launchState: "running",
      launchError: undefined,
      interruptedAt: recoveredAt,
      recoveredFromBootId: entry.bootId,
    });
    log(`[session-recovery] reopened ${entry.sessionId.slice(0, 8)} after boot without replaying its turn`);
    result.recovered++;
  }
  return result;
}
