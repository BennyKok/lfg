import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PATHS } from "../config.ts";

export type InputSpec =
  | { kind: "git_log"; repo?: string; since?: string; pretty?: string }
  | {
      // Live OpenRouter model catalog (id, name, context, per-1M pricing) for
      // the model-watch agent to diff against a shortlist. Public,
      // unauthenticated. `filter` narrows to substrings of id/name.
      kind: "openrouter_models";
      filter?: string[];
      limit?: number;
    }
  | {
      // Deterministic price-drift verdict for the OpenRouter models we carry.
      // Parses SupportedModels out of llm.go and diffs each carried price
      // against the live PER-MODEL endpoint envelope ([min..max] across every
      // provider), flagging only prices that fall outside what any provider
      // offers. Unlike `openrouter_models` (which diffs the flapping cheapest-
      // endpoint catalog floor), this does not false-flag provider spread.
      kind: "openrouter_drift";
      llm_go?: string;
    }
  | { kind: "github_issues"; repo: string; state?: string; limit?: number }
  | { kind: "github_prs"; repo: string; state?: string; limit?: number }
  | {
      kind: "repo_files";
      repo?: string;
      globs: string[];
      max_files?: number;
      max_bytes_per_file?: number;
      max_total_bytes?: number;
    }
  | {
      // Read-only host + supply-chain security sweep on this box (the machine
      // lfg runs on): login/access history, account/sudo surface, listening
      // ports, persistence (cron/systemd), rootkit indicators, recently-changed
      // system binaries, and `bun audit`/`npm audit` + known-bad-package IoCs.
      // The probe set is hardcoded (no command injection); `sections` selects
      // which groups to run (default all), `repo` points the supply-chain audit.
      kind: "security_scan";
      sections?: string[];
      repo?: string;
    };

export const KNOWN_INPUT_KINDS = new Set<InputSpec["kind"]>([
  "git_log",
  "openrouter_models",
  "openrouter_drift",
  "github_issues",
  "github_prs",
  "repo_files",
  "security_scan",
]);

export type AgentFrontmatter = {
  name: string;
  title?: string;
  schedule?: string;
  enabled?: boolean;
  inputs?: InputSpec[];
  context_files?: string[];
  output?: { dir?: string };
};

export type Agent = {
  name: string;
  filePath: string;
  frontmatter: AgentFrontmatter;
  body: string;
  raw: string;
};

export const AGENTS_DIR = join(PATHS.root, "agents");
// Private, gitignored agents live under data/ (e.g. ones that depend on the
// local collector plugin). They take precedence over a same-named tracked agent.
export const LOCAL_AGENTS_DIR = join(PATHS.data, "agents");

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseAgentFile(raw: string, filePath: string): Agent {
  const m = FM_RE.exec(raw);
  if (!m) {
    throw new Error(`agent ${filePath}: missing YAML frontmatter`);
  }
  let fm: AgentFrontmatter;
  try {
    fm = parseYaml(m[1]) as AgentFrontmatter;
  } catch (e) {
    throw new Error(
      `agent ${filePath}: YAML parse error: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!fm || typeof fm !== "object") {
    throw new Error(`agent ${filePath}: frontmatter must be a mapping`);
  }
  if (!fm.name) throw new Error(`agent ${filePath}: missing 'name'`);
  validateFrontmatter(fm, filePath);
  return {
    name: fm.name,
    filePath,
    frontmatter: fm,
    body: m[2],
    raw,
  };
}

const warnedKinds = new Set<string>();

export function validateFrontmatter(fm: AgentFrontmatter, where: string) {
  for (const inp of fm.inputs ?? []) {
    if (!KNOWN_INPUT_KINDS.has(inp.kind) && !warnedKinds.has(inp.kind)) {
      // Not a built-in kind. It may be served by the optional local collector
      // plugin (data/agents/collectors/), which resolves at run time — so warn
      // once rather than reject. runCollector throws clearly if nothing handles it.
      warnedKinds.add(inp.kind);
      console.warn(
        `[registry] input.kind '${inp.kind}' is not built-in; expecting a local collector plugin to handle it`,
      );
    }
  }
}

// Resolve an agent file to its on-disk path, preferring the private local dir
// over the tracked one. Returns null if neither has it.
async function resolveAgentPath(name: string): Promise<string | null> {
  const local = join(LOCAL_AGENTS_DIR, `${name}.md`);
  if (await Bun.file(local).exists()) return local;
  const tracked = join(AGENTS_DIR, `${name}.md`);
  if (await Bun.file(tracked).exists()) return tracked;
  return null;
}

export async function loadAgent(name: string): Promise<Agent> {
  const filePath = await resolveAgentPath(name);
  if (!filePath) {
    throw new Error(`agent '${name}' not found in ${LOCAL_AGENTS_DIR} or ${AGENTS_DIR}`);
  }
  const raw = await Bun.file(filePath).text();
  return parseAgentFile(raw, filePath);
}

export async function listAgents(): Promise<Agent[]> {
  // Local (private) dir is read last so a same-named agent overrides the tracked
  // one; `byName` keeps the last write per name.
  const byName = new Map<string, Agent>();
  for (const dir of [AGENTS_DIR, LOCAL_AGENTS_DIR]) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(dir, f);
      const raw = await Bun.file(filePath).text();
      try {
        const agent = parseAgentFile(raw, filePath);
        byName.set(agent.name, agent);
      } catch (e) {
        console.error(`[registry] skipping ${filePath}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeAgent(name: string, raw: string): Promise<Agent> {
  // Save back to wherever the agent already lives (private dir wins); new agents
  // default to the tracked dir.
  const filePath = (await resolveAgentPath(name)) ?? join(AGENTS_DIR, `${name}.md`);
  const agent = parseAgentFile(raw, filePath);
  if (agent.name !== name) {
    throw new Error(
      `agent file '${name}.md' frontmatter says name='${agent.name}'; mismatch`,
    );
  }
  const tmp = `${filePath}.tmp-${Date.now()}`;
  await Bun.write(tmp, raw);
  await Bun.$`mv ${tmp} ${filePath}`.quiet();
  return agent;
}
