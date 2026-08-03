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

const LIMITS: Readonly<Record<AgentAdmissionPlan, number>> = {
  // One interactive coding agent can use most of the 512 MiB free Computer.
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
  | { ok: true; release: () => void }
  | { ok: false; active: number; reserved: number };

export class AgentAdmissionController {
  private readonly pending = new Set<string>();

  tryAcquire(
    limit: number,
    sessions: readonly AgentActivity[],
  ): AgentAdmission {
    const active = activeAgentCount(sessions);
    if (active + this.pending.size >= limit) {
      return { ok: false, active, reserved: this.pending.size };
    }

    const token = crypto.randomUUID();
    this.pending.add(token);
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
}
import { readFileSync } from "node:fs";
