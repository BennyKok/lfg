/**
 * The single admission owner for a Computer's agent work.
 *
 * A session launch is not visible in the session list until its managed row is
 * written. Reserving the slot after each caller has read that list closes the
 * otherwise inevitable await race: JavaScript runs this check-and-reserve
 * section atomically between promise continuations.
 */

export type AgentAdmissionPlan =
  | "free"
  | "computer_trial"
  | "computer_5"
  | "computer_10"
  | "computer_20"
  | "computer_early";

export type AgentAdmissionContext = {
  plan: AgentAdmissionPlan;
  limit: number;
};

export type AgentActivity = {
  busy?: boolean;
  launching?: boolean;
};

export type AgentMemoryBudget = {
  availableBytes: number;
  reserveBytes: number;
  launchBytes: number;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * A launch must leave enough memory for LFG, the OS, and the tunnel to keep
 * answering while the agent runtime initializes. Existing processes are
 * already reflected in availableBytes; launchBytes reserves only starts that
 * passed admission but have not consumed their memory yet.
 */
export function agentLaunchMemoryBudget(
  totalBytes: number,
  availableBytes: number,
): AgentMemoryBudget {
  const total = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0;
  const available = Number.isFinite(availableBytes) ? Math.max(0, availableBytes) : 0;
  return {
    availableBytes: available,
    reserveBytes: Math.max(768 * MIB, Math.ceil(total * 0.1)),
    launchBytes: GIB,
  };
}

const LIMITS: Readonly<Record<AgentAdmissionPlan, number>> = {
  // Free stays single-agent; its 4 GiB machine now has enough headroom for the
  // runtime, LFG, and the OS instead of forcing all three into 512 MiB.
  free: 1,
  computer_trial: 1,
  // Paid tiers keep roughly 1.5–1.6 GiB of RAM available per admitted agent.
  // Admission is a safety ceiling, not a promise that every agent owns a CPU.
  computer_5: 5,
  computer_10: 16,
  computer_20: 24,
  computer_early: 24,
};

const COMPUTER_PLAN_FILE = "/etc/omg/computer-plan";

function currentComputerPlan(planFile: string): string | undefined {
  try {
    // The control plane owns this root-written file and atomically replaces it
    // while LFG is live. Reading it per admission makes downgrades immediate;
    // a process-start environment variable cannot do that.
    return readFileSync(planFile, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Standalone LFG has no managed plan file, so retain the bootstrap env as
    // its compatibility bridge. Any other file failure fails safe to Free.
    return code === "ENOENT"
      ? process.env.LFG_COMPUTER_PLAN
      : "invalid-managed-plan";
  }
}

/** The per-Computer plan is supplied only by the trusted control plane. */
export function computerAgentAdmissionContext(
  rawPlan?: string,
  planFile = COMPUTER_PLAN_FILE,
): AgentAdmissionContext | null {
  const selectedPlan =
    rawPlan === undefined ? currentComputerPlan(planFile) : rawPlan;
  if (!selectedPlan?.trim()) return null;
  const plan = selectedPlan.trim().toLowerCase();
  if (
    plan === "computer_trial" ||
    plan === "computer_5" ||
    plan === "computer_10" ||
    plan === "computer_20" ||
    plan === "computer_early"
  ) {
    return { plan, limit: LIMITS[plan] };
  }
  // A stale or malformed cloud-plan value must fail safe for the Computer,
  // while ordinary non-Computer LFG installs keep their local setting policy.
  return { plan: "free", limit: LIMITS.free };
}

export function activeAgentCount(sessions: readonly AgentActivity[]): number {
  return sessions.filter((session) => session.busy || session.launching).length;
}

export type AgentAdmission =
  | { ok: true; release: () => void; reclaimed?: number }
  | { ok: false; reason: "limit"; active: number; reserved: number }
  | {
      ok: false;
      reason: "memory";
      active: number;
      reserved: number;
      availableBytes: number;
      requiredBytes: number;
    };

export class AgentAdmissionController {
  private readonly pending = new Map<string, number>();
  private transition: Promise<void> = Promise.resolve();

  /**
   * Serializes the complete inspect -> optional reclaim -> reserve transition.
   * A memory-pressure reclaim awaits process shutdown, so `tryAcquire` alone
   * cannot own that transition atomically. Keeping the queue here makes one
   * controller the sole admission owner even while cleanup is asynchronous.
   */
  async acquire(
    limit: number,
    inspect: () => Promise<{
      sessions: readonly AgentActivity[];
      memory?: AgentMemoryBudget;
    }>,
    reclaim?: () => Promise<number>,
  ): Promise<AgentAdmission> {
    let releaseTransition!: () => void;
    const previous = this.transition;
    this.transition = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    await previous;
    try {
      let snapshot = await inspect();
      let admission = this.tryAcquire(limit, snapshot.sessions, snapshot.memory);
      if (!admission.ok && admission.reason === "memory" && reclaim) {
        const reclaimed = await reclaim();
        if (reclaimed > 0) {
          snapshot = await inspect();
          admission = this.tryAcquire(limit, snapshot.sessions, snapshot.memory);
          if (admission.ok) return { ...admission, reclaimed };
        }
      }
      return admission;
    } finally {
      releaseTransition();
    }
  }

  tryAcquire(
    limit: number,
    sessions: readonly AgentActivity[],
    memory?: AgentMemoryBudget,
  ): AgentAdmission {
    const active = activeAgentCount(sessions);
    if (active + this.pending.size >= limit) {
      return { ok: false, reason: "limit", active, reserved: this.pending.size };
    }

    const reservedBytes = [...this.pending.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (memory) {
      const availableBytes = Math.max(0, memory.availableBytes - reservedBytes);
      const requiredBytes = memory.reserveBytes + memory.launchBytes;
      if (availableBytes < requiredBytes) {
        return {
          ok: false,
          reason: "memory",
          active,
          reserved: this.pending.size,
          availableBytes,
          requiredBytes,
        };
      }
    }

    const token = crypto.randomUUID();
    this.pending.set(token, memory?.launchBytes ?? 0);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.pending.delete(token);
      },
    };
  }

  get reserved(): number {
    return this.pending.size;
  }

  get reservedBytes(): number {
    return [...this.pending.values()].reduce((sum, bytes) => sum + bytes, 0);
  }
}
import { readFileSync } from "node:fs";
