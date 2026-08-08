/**
 * Client for the usage API.
 *
 * The server exposes each usage source separately — one entry per connected
 * Claude account, plus one per other provider — so the UI never blocks the fast
 * sources behind the slow ones. `useUsageFeed` fetches the (network-free)
 * directory first, then every source in parallel, publishing each as it lands.
 * `useProviderUsage` pulls a single source for surfaces that only show one ring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/omg-client";

export type UsageWindow = {
  label: string;
  pct: number | null;
  resetsAt: number | null;
};

export type UsageProviderRef = {
  /** Stable per-source id — "codex", or "claude:<accountId>". */
  id: string;
  /** Provider family, which is what maps to an agent icon. */
  kind: string;
  label: string;
  accountId?: string;
  accountLabel?: string;
  accountNumber?: number;
};

export type ProviderUsage = UsageProviderRef & {
  available: boolean;
  plan?: string | null;
  note?: string;
  windows?: UsageWindow[];
};

function providerPath(id: string, force: boolean): string {
  return `/api/usage/${encodeURIComponent(id)}${force ? "?force=1" : ""}`;
}

export async function fetchProviderUsage(
  id: string,
  force = false,
): Promise<ProviderUsage> {
  const payload = await api<{ provider: ProviderUsage }>(providerPath(id, force));
  return payload.provider;
}

// The directory is derived from local files only, but it's still a round-trip,
// and the composer asks for it every time it opens. A short memo keeps opening
// the composer free while staying current enough to notice a new account.
const DIRECTORY_TTL_MS = 20_000;
let directoryCache: { at: number; refs: UsageProviderRef[] } | null = null;
let directoryInflight: Promise<UsageProviderRef[]> | null = null;

export async function fetchUsageProviders(force = false): Promise<UsageProviderRef[]> {
  if (!force) {
    if (directoryCache && Date.now() - directoryCache.at < DIRECTORY_TTL_MS)
      return directoryCache.refs;
    if (directoryInflight) return directoryInflight;
  }
  const run = api<{ providers: UsageProviderRef[] }>("/api/usage/providers")
    .then((payload) => {
      const refs = payload.providers ?? [];
      directoryCache = { at: Date.now(), refs };
      return refs;
    })
    .finally(() => {
      if (directoryInflight === run) directoryInflight = null;
    });
  directoryInflight = run;
  return run;
}

/** Forget the memoized directory — call after adding or removing an account. */
export function invalidateUsageProviders(): void {
  directoryCache = null;
}

/**
 * Which usage provider family backs a given agent kind. The ai-sdk variants
 * share the underlying provider account with their CLI counterpart.
 */
export function usageProviderKind(agent: string): string {
  if (agent === "aisdk") return "claude";
  if (agent === "codex-aisdk") return "codex";
  return agent;
}

/** The source that should back a composer showing `agent` on `accountId`. */
export function matchUsageProvider<T extends UsageProviderRef>(
  refs: T[],
  agent: string,
  accountId?: string | null,
): T | null {
  const kind = usageProviderKind(agent);
  const ofKind = refs.filter((ref) => ref.kind === kind);
  if (!ofKind.length) return null;
  if (accountId) {
    const exact = ofKind.find((ref) => ref.accountId === accountId);
    if (exact) return exact;
  }
  return ofKind[0];
}

export type UsageFeed = {
  /** Known sources, in display order — available before any usage resolves. */
  refs: UsageProviderRef[] | null;
  /** Resolved usage, in ref order. Grows as individual sources land. */
  providers: ProviderUsage[];
  /** True until every source has answered (or failed). */
  loading: boolean;
  /** True while a refresh is in flight, even with results already on screen. */
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
};

/**
 * Every usage source, resolved independently. `enabled: false` keeps the hook
 * inert so a closed overlay costs nothing.
 */
export function useUsageFeed({
  enabled = true,
  refreshMs = 0,
}: { enabled?: boolean; refreshMs?: number } = {}): UsageFeed {
  const [refs, setRefs] = useState<UsageProviderRef[] | null>(null);
  const [resolved, setResolved] = useState<Record<string, ProviderUsage>>({});
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  // Only the newest load may write state — a refresh landing after a slower
  // earlier one must not resurrect its results.
  const generation = useRef(0);

  const load = useCallback(
    async (force: boolean) => {
      const gen = ++generation.current;
      setPending((n) => n + 1);
      try {
        const directory = await fetchUsageProviders(force);
        if (generation.current !== gen) return;
        setRefs(directory);
        setError(null);
        // Drop entries for sources that no longer exist (a removed account).
        const live = new Set(directory.map((ref) => ref.id));
        setResolved((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => live.has(id))),
        );
        await Promise.all(
          directory.map(async (ref) => {
            try {
              const provider = await fetchProviderUsage(ref.id, force);
              if (generation.current !== gen) return;
              // Publish each source the moment it lands rather than waiting for
              // the slowest one, so fast providers paint immediately.
              setResolved((current) => ({ ...current, [ref.id]: provider }));
            } catch {
              if (generation.current !== gen) return;
              setResolved((current) => ({
                ...current,
                [ref.id]: { ...ref, available: false, note: "Couldn't read usage" },
              }));
            }
          }),
        );
      } catch (e) {
        if (generation.current !== gen) return;
        setError(e instanceof Error ? e.message : "Couldn't load usage");
      } finally {
        if (generation.current === gen) setSettled(true);
        setPending((n) => n - 1);
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    void load(false);
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || !refreshMs) return;
    const timer = window.setInterval(() => void load(false), refreshMs);
    return () => window.clearInterval(timer);
  }, [enabled, load, refreshMs]);

  const providers = useMemo(
    () =>
      (refs ?? [])
        .map((ref) => resolved[ref.id])
        .filter((provider): provider is ProviderUsage => Boolean(provider)),
    [refs, resolved],
  );

  const refresh = useCallback(() => void load(true), [load]);

  return {
    refs,
    providers,
    loading: !settled && !error,
    refreshing: pending > 0,
    error,
    refresh,
  };
}

/**
 * A single source, for surfaces that show one ring (the composer). Resolves the
 * id from the agent + Claude account so switching accounts re-reads that
 * account's own limits.
 */
export function useProviderUsage({
  agent,
  accountId,
  enabled = true,
}: {
  agent: string;
  accountId?: string | null;
  enabled?: boolean;
}): { usage: ProviderUsage | null; loading: boolean } {
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setUsage(null);
      return;
    }
    const gen = ++generation.current;
    setUsage(null);
    setLoading(true);
    void (async () => {
      try {
        const refs = await fetchUsageProviders();
        if (generation.current !== gen) return;
        const ref = matchUsageProvider(refs, agent, accountId);
        if (!ref) {
          setUsage(null);
          return;
        }
        const provider = await fetchProviderUsage(ref.id);
        if (generation.current !== gen) return;
        setUsage(provider);
      } catch {
        if (generation.current === gen) setUsage(null);
      } finally {
        if (generation.current === gen) setLoading(false);
      }
    })();
  }, [agent, accountId, enabled]);

  return { usage, loading };
}
