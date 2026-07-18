// Custom agent profiles — a generic, opt-in seam for pointing a managed coding
// agent at extra system-prompt text, extra skills, and a display-name override,
// sourced from a plain local directory. Think of it like a user's own
// `~/.claude/CLAUDE.md`: a reusable customization mechanism that layers ON TOP
// of an agent's built-in defaults, updates without an LFG code change or
// release, and is a complete no-op when unconfigured.
//
// This is intentionally backend-agnostic. It is currently wired only into the
// "pi" backend (see agents/backends/pi-session.ts) via the LFG_PI_PROFILE_DIR
// env var, because pi's own CLI already exposes the primitives we lean on
// (`--append-system-prompt <path>` and `--skill <path>`). The loader/arg
// builder below take the env-var NAME as a parameter so other backends can
// adopt the same convention later without duplicating this logic.
//
// Directory layout (all parts optional — a profile can supply any subset):
//   <profile-dir>/
//     system-prompt.md   (or system-prompt.txt)  extra system-prompt text,
//                                                 appended to the agent's own
//                                                 default system prompt.
//     skills/            a directory of <name>/SKILL.md skill subfolders,
//                        added to the agent's discovered skills.
//     name               (or profile.json {"displayName": "..."})  a plain-text
//                        display name shown in the UI instead of the raw agent
//                        kind.
//
// Nothing here is product- or partner-specific: the profile directory is
// supplied by the operator, and its contents never live in this repo.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type AgentProfile = {
  /** Absolute path to the resolved profile directory. */
  dir: string;
  /**
   * Absolute path to the extra system-prompt file, when one exists. Passed to
   * pi as `--append-system-prompt <path>` (pi reads file contents when the
   * argument resolves to an existing file).
   */
  systemPromptPath?: string;
  /**
   * Absolute path to the skills directory, when one exists. Passed to pi as
   * `--skill <path>`; pi recurses to load every `<name>/SKILL.md` under it.
   */
  skillsDir?: string;
  /** Display-name override, when one is configured (non-empty after trimming). */
  displayName?: string;
};

// Conventional filenames, checked in order. First match wins.
const SYSTEM_PROMPT_FILES = ["system-prompt.md", "system-prompt.txt"] as const;
const NAME_FILE = "name";
const PROFILE_JSON = "profile.json";
const SKILLS_DIR = "skills";

function warn(message: string): void {
  // Never throw from profile loading — a broken/partial profile must degrade to
  // "no customization", not crash the harness. Surface the reason so an operator
  // can see why their profile was skipped.
  console.error(`[agent-profile] ${message}`);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readDisplayName(dir: string): string | undefined {
  // Plain `name` file wins — it is the simplest thing an operator can drop in.
  const namePath = join(dir, NAME_FILE);
  if (isFile(namePath)) {
    try {
      const value = readFileSync(namePath, "utf8").trim();
      if (value) return value;
    } catch (e) {
      warn(`could not read ${namePath}: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Fall back to profile.json { "displayName": "..." }.
  const jsonPath = join(dir, PROFILE_JSON);
  if (isFile(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { displayName?: unknown };
      if (typeof parsed.displayName === "string" && parsed.displayName.trim()) {
        return parsed.displayName.trim();
      }
    } catch (e) {
      warn(`could not parse ${jsonPath}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return undefined;
}

/**
 * Load a custom agent profile from an explicit directory path. Returns null when
 * `dirValue` is empty/unset or does not resolve to an existing directory — both
 * are ordinary "no profile configured" cases and are logged only when a value
 * was given but unusable. Missing individual parts (no system prompt, no skills,
 * no name) are skipped silently; the profile is still returned for whatever
 * parts DO exist.
 */
export function loadAgentProfile(dirValue: string | undefined | null): AgentProfile | null {
  const raw = dirValue?.trim();
  if (!raw) return null;
  const dir = resolve(raw);
  if (!existsSync(dir)) {
    warn(`profile directory does not exist, ignoring: ${dir}`);
    return null;
  }
  if (!isDir(dir)) {
    warn(`profile path is not a directory, ignoring: ${dir}`);
    return null;
  }

  const profile: AgentProfile = { dir };

  for (const candidate of SYSTEM_PROMPT_FILES) {
    const path = join(dir, candidate);
    if (isFile(path)) {
      profile.systemPromptPath = path;
      break;
    }
  }

  const skills = join(dir, SKILLS_DIR);
  if (existsSync(skills)) {
    if (isDir(skills)) profile.skillsDir = skills;
    else warn(`skills path is not a directory, skipping: ${skills}`);
  }

  const displayName = readDisplayName(dir);
  if (displayName) profile.displayName = displayName;

  return profile;
}

/**
 * Load a profile from a named environment variable (e.g. "LFG_PI_PROFILE_DIR").
 * Keeps the env-var name out of the loader so the same mechanism can back other
 * backends later.
 */
export function loadAgentProfileFromEnv(envVar: string): AgentProfile | null {
  return loadAgentProfile(process.env[envVar]);
}

/**
 * Build the additive pi CLI args for a profile: `--append-system-prompt <path>`
 * for the system prompt file and `--skill <dir>` for the skills directory. Both
 * pi flags are additive — they do NOT replace pi's built-in system prompt or its
 * auto-discovered project skills. Returns [] for a null profile or one with no
 * usable parts, so callers can always spread the result unconditionally.
 */
export function agentProfileCliArgs(profile: AgentProfile | null): string[] {
  if (!profile) return [];
  const args: string[] = [];
  if (profile.systemPromptPath) args.push("--append-system-prompt", profile.systemPromptPath);
  if (profile.skillsDir) args.push("--skill", profile.skillsDir);
  return args;
}
