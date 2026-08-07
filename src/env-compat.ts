// The project's configuration prefix is migrating from LFG_* to OMG_*.
//
// Rewriting all ~170 `process.env.LFG_*` read sites in one go would break every
// existing install the moment it updated: their .env files, systemd units and
// launchd plists all still say LFG_*. Instead both spellings are aliased onto
// each other once, at startup, before any module reads its configuration. New
// installs get OMG_*, old installs keep working untouched, and read sites can
// migrate to the new prefix at their own pace.
//
// OMG_* wins when a name is set both ways: the new prefix is what a current
// install writes, so it is the more deliberate of the two.

export const ENV_PREFIX = "OMG_";
export const ENV_PREFIX_LEGACY = "LFG_";

export type EnvLike = Record<string, string | undefined>;

/**
 * Mirror every OMG_ and LFG_ variable onto its counterpart, in place.
 *
 * Idempotent, so it is safe to call from more than one entrypoint. Returns the
 * suffixes it touched, which the tests assert on.
 */
export function applyEnvAliases(env: EnvLike = process.env as EnvLike): string[] {
  const touched: string[] = [];
  // Snapshot: assigning into `env` during iteration would otherwise revisit keys.
  const keys = Object.keys(env);

  // Pass 1 — the new prefix is authoritative, so it propagates outward first.
  for (const key of keys) {
    if (!key.startsWith(ENV_PREFIX)) continue;
    const suffix = key.slice(ENV_PREFIX.length);
    if (!suffix) continue;
    const value = env[key];
    if (value === undefined) continue;
    const legacyKey = ENV_PREFIX_LEGACY + suffix;
    if (env[legacyKey] === value) continue;
    env[legacyKey] = value;
    touched.push(suffix);
  }

  // Pass 2 — fill in the new prefix from legacy names that had no OMG_ value.
  for (const key of keys) {
    if (!key.startsWith(ENV_PREFIX_LEGACY)) continue;
    const suffix = key.slice(ENV_PREFIX_LEGACY.length);
    if (!suffix) continue;
    const value = env[key];
    if (value === undefined) continue;
    const nextKey = ENV_PREFIX + suffix;
    if (env[nextKey] !== undefined) continue;
    env[nextKey] = value;
    touched.push(suffix);
  }

  return touched;
}
