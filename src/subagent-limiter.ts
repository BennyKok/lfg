export const DEFAULT_MAX_CONCURRENT_AGENTS = 6;
export const MAX_CONCURRENT_AGENTS_LIMIT = 6;

export function maxConcurrentAgents(env = process.env): number {
  const raw = env.LFG_MAX_CONCURRENT_AGENTS?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_AGENTS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_CONCURRENT_AGENTS_LIMIT)
    : DEFAULT_MAX_CONCURRENT_AGENTS;
}

type Waiter = {
  name: string;
  queuedAt: number;
  resolve: (value: { queuedForMs: number }) => void;
};

/**
 * Process-local admission control for LFG-managed subagents. A lease remains
 * held for the lifetime of the tmux session, not merely for the create request.
 * The systemd slice is the authoritative memory boundary; this limiter keeps
 * normal operation comfortably below it.
 */
export class SubagentLimiter {
  private _max: number;
  private active = new Map<string, number>();
  private queue: Waiter[] = [];

  constructor(max = maxConcurrentAgents()) {
    this._max = Math.max(1, Math.min(MAX_CONCURRENT_AGENTS_LIMIT, Math.floor(max)));
  }

  get max(): number {
    return this._max;
  }

  setMax(max: number): void {
    this._max = Math.max(1, Math.min(MAX_CONCURRENT_AGENTS_LIMIT, Math.floor(max)));
    this.drain();
  }

  restore(names: Iterable<string>): void {
    for (const name of names) {
      if (!this.active.has(name)) this.active.set(name, 0);
    }
  }

  acquire(name: string): Promise<{ queuedForMs: number }> {
    if (this.active.has(name)) return Promise.resolve({ queuedForMs: 0 });
    if (this.active.size < this._max) {
      this.active.set(name, Date.now());
      return Promise.resolve({ queuedForMs: 0 });
    }
    return new Promise((resolve) => {
      this.queue.push({ name, queuedAt: Date.now(), resolve });
    });
  }

  release(name: string): boolean {
    const removed = this.active.delete(name);
    if (removed) this.drain();
    return removed;
  }

  reconcile(isAlive: (name: string) => boolean, now = Date.now()): void {
    for (const [name, acquiredAt] of this.active) {
      // A newly admitted request has a short window before tmux exists.
      if (acquiredAt > 0 && now - acquiredAt < 10_000) continue;
      if (!isAlive(name)) this.active.delete(name);
    }
    this.drain();
  }

  snapshot(): { max: number; active: string[]; queued: string[] } {
    return {
      max: this._max,
      active: [...this.active.keys()],
      queued: this.queue.map((waiter) => waiter.name),
    };
  }

  private drain(): void {
    while (this.active.size < this._max && this.queue.length) {
      const waiter = this.queue.shift()!;
      this.active.set(waiter.name, Date.now());
      waiter.resolve({ queuedForMs: Date.now() - waiter.queuedAt });
    }
  }
}
