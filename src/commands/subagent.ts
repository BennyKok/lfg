import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  MODEL_OPTIONS,
  listModelCatalog,
  thinkingLevelsForAgent,
  type ModelCatalogItem,
} from "../agent-catalog.ts";

const HELP = `lfg subagent — spawn managed worker sessions across harnesses

Usage:
  lfg subagent list [--parent SESSION_ID] [--json]
  lfg subagent models [--json]
  lfg subagent create --prompt "..." --agent codex-aisdk --model gpt-5.5
  lfg subagent create --prompt-file task.md --agent aisdk --model opus --cwd /path/to/repo

Options:
  --agent aisdk|codex-aisdk|opencode|hermes|grok|claude|codex
  --model MODEL
  --thinking-level LEVEL
  --cwd PATH
  --parent SESSION_ID
  --user EMAIL
  --worktree
  --json

Env:
  LFG_BASE, or LFG_PORT/LFG_HOST. Defaults to http://127.0.0.1:8766.
  LFG_SESSION_ID is used as the parent when --parent is omitted.
`;

type Repo = { name: string; cwd: string; project?: string };
type SessionCreateResponse = {
  ok?: boolean;
  sessionId?: string;
  tmuxName?: string;
  cwd?: string;
  agent?: string;
  worktree?: string | null;
};
type SessionRow = {
  sessionId: string | null;
  nativeSessionId?: string | null;
  title?: string | null;
  agent?: string;
  model?: string | null;
  project?: string;
  parentSessionId?: string | null;
  parentNativeSessionId?: string | null;
  busy?: boolean;
};

export async function cmdSubagent(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case "ls":
      return cmdList(rest);
    case "models":
      return cmdModels(rest);
    case "create":
    case "new":
    case "spawn":
      return cmdCreate(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown subagent subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function baseUrl(): string {
  if (process.env.LFG_BASE) return process.env.LFG_BASE.replace(/\/$/, "");
  const host = process.env.LFG_HOST || "127.0.0.1";
  const port = process.env.LFG_PORT || process.env.PORT || "8766";
  return `http://${host}:${port}`;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

function cmdModels(args: string[]) {
  const models = listModelCatalog();
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ models }, null, 2));
    return;
  }
  for (const item of models.filter((model) => model.session)) {
    printModel(item);
  }
}

function printModel(item: ModelCatalogItem) {
  console.log(`${item.key.padEnd(13)} ${item.defaultModel}`);
  console.log(`  models: ${item.models.join(", ")}`);
  if (item.thinkingLevels.length) console.log(`  thinking: ${item.thinkingLevels.join(", ")}`);
}

function activeParent(): string | undefined {
  if (process.env.LFG_SESSION_ID) return process.env.LFG_SESSION_ID;
  try {
    return readFileSync(`${homedir()}/.lfg/active-session`, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function cmdList(args: string[]) {
  const parent = hasFlag(args, "--all")
    ? undefined
    : option(args, "--parent")?.trim() || activeParent();
  const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
  const children = sessions.filter((session) => {
    if (!session.parentSessionId && !session.parentNativeSessionId) return false;
    if (!parent) return true;
    return session.parentSessionId === parent || session.parentNativeSessionId === parent;
  });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ parentSessionId: parent ?? null, subagents: children }, null, 2));
    return;
  }
  if (!children.length) {
    console.log(parent ? `no subagents for ${parent}` : "no subagents");
    return;
  }
  for (const child of children) {
    const id = child.sessionId ?? child.nativeSessionId ?? "";
    const state = child.busy ? "busy" : "idle";
    const model = child.model ? `/${child.model}` : "";
    console.log(`${state.padEnd(5)} ${id.slice(0, 8)}  ${child.agent ?? "agent"}${model}  ${child.title ?? child.project ?? ""}`);
  }
}

async function resolveRepo(input: string | undefined): Promise<string | undefined> {
  const wanted = resolve(input || process.cwd());
  const { repos } = await api<{ repos: Repo[] }>("/api/repos");
  const exact = repos.find((repo) => resolve(repo.cwd) === wanted);
  if (exact) return exact.cwd;
  const containing = repos
    .filter((repo) => wanted === resolve(repo.cwd) || wanted.startsWith(`${resolve(repo.cwd)}/`))
    .sort((a, b) => b.cwd.length - a.cwd.length)[0];
  if (containing) return containing.cwd;
  return input ? wanted : undefined;
}

async function cmdCreate(args: string[]) {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(HELP);
    return;
  }
  const promptInline = option(args, "--prompt");
  const promptFile = option(args, "--prompt-file");
  if (!promptInline && !promptFile) {
    console.error("Usage: lfg subagent create --prompt|--prompt-file TEXT --agent codex-aisdk");
    process.exit(1);
  }
  const prompt = (promptFile ? await Bun.file(promptFile).text() : promptInline ?? "").trim();
  if (!prompt) {
    console.error("subagent prompt is empty");
    process.exit(1);
  }
  const agent = option(args, "--agent")?.trim() || "aisdk";
  if (!MODEL_OPTIONS[agent as keyof typeof MODEL_OPTIONS]) {
    console.error(`unknown agent "${agent}"`);
    process.exit(1);
  }
  const model = option(args, "--model")?.trim() || MODEL_OPTIONS[agent as keyof typeof MODEL_OPTIONS].defaultModel;
  const thinkingLevel = option(args, "--thinking-level")?.trim();
  if (thinkingLevel) {
    const allowed = thinkingLevelsForAgent(agent);
    if (!allowed || !allowed.includes(thinkingLevel)) {
      console.error(`unknown thinking level "${thinkingLevel}" for ${agent}`);
      process.exit(1);
    }
  }
  const cwd = await resolveRepo(option(args, "--cwd"));
  const parentSessionId = hasFlag(args, "--no-parent")
    ? undefined
    : option(args, "--parent")?.trim() || activeParent();
  const body = {
    prompt,
    cwd,
    agent,
    model,
    thinkingLevel,
    parentSessionId,
    spawnedBy: "subagent",
    user: option(args, "--user"),
    worktree: hasFlag(args, "--worktree") ? true : undefined,
  };
  const created = await api<SessionCreateResponse>("/api/sessions/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ subagent: created, parentSessionId: parentSessionId ?? null }, null, 2));
    return;
  }
  console.log(
    `created ${created.agent ?? agent} subagent ${created.sessionId ?? created.tmuxName ?? "(launching)"} in ${created.cwd ?? cwd ?? "default repo"}`,
  );
}
