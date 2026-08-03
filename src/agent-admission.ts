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
  // Leave CPU and RAM room for the LFG server, Vite, and the OS. These are
  // deliberately below the vCPU count once each agent has a real tool turn.
  computer_5: 2,
  computer_10: 4,
  computer_20: 8,
  computer_early: 8,
};

/** The per-Computer plan is supplied only by the trusted bootstrap command. */
export function computerAgentAdmissionContext(
  rawPlan = process.env.LFG_COMPUTER_PLAN,
): AgentAdmissionContext | null {
  if (!rawPlan?.trim()) return null;
  const plan = rawPlan.trim().toLowerCase();
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

  tryAcquire(limit: number, sessions: readonly AgentActivity[]): AgentAdmission {
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
