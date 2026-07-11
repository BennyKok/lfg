import { listAgents, loadAgent } from "../agents/registry.ts";
import { runAgent, runAllAgents } from "../agents/runner.ts";
import { listAutoAgents, saveAutoAgent } from "../auto/store.ts";
import {
  AUTO_AGENT_BACKENDS,
  MODEL_OPTIONS,
  buildAgentBrowserTree,
  listModelCatalog,
  modelsForAgent,
  thinkingLevelsForAgent,
  type AutoAgentBackend,
} from "../agent-catalog.ts";
import { listCodingAgents } from "../coding-agents.ts";
import { readModelDiscoveryCacheSync, refreshModelCatalog } from "../model-discovery.ts";
import { listSkillCatalog } from "../skills-catalog.ts";

const HELP = `lfg agents — multi-agent insight runner

Usage:
  lfg agents list                 List agents (name, title, enabled)
  lfg agents models [--json]      List provider/model options
  lfg agents models --refresh     Refresh provider model catalogs now
  lfg agents browser [--json]     Browse providers, skills, insight agents, auto agents
  lfg agents catalog [--json]     Alias for browser
  lfg agents create-auto          Create a scheduled auto agent
  lfg agents run --all            Run every enabled agent (cron path)
  lfg agents run <name>           Run a single agent
  lfg agents run <name> --dry     Build the prompt only, don't call claude
  lfg agents show <name>          Print agent frontmatter + body

Create auto agent:
  lfg agents create-auto --name NAME --prompt-file prompt.md --schedule "0 9 * * *"
  lfg agents create-auto --name NAME --prompt "..." --schedule "*/30 * * * *" --backend codex-aisdk --model gpt-5.5
`;

export async function cmdAgents(args: string[]) {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return cmdList();
    case "models":
      return cmdModels(rest);
    case "browser":
    case "catalog":
      return cmdBrowser(rest);
    case "create-auto":
      return cmdCreateAuto(rest);
    case "run":
      return cmdRun(rest);
    case "show":
      return cmdShow(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown agents subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
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

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    else if (arg === name && args[i + 1]) values.push(args[++i]);
  }
  return values;
}

async function cmdList() {
  const agents = await listAgents();
  if (!agents.length) {
    console.log("(no agents found — drop files in agents/<name>.md)");
    return;
  }
  for (const a of agents) {
    const enabled = a.frontmatter.enabled === false ? "OFF" : "on ";
    const title = a.frontmatter.title ?? "";
    const inputs = (a.frontmatter.inputs ?? []).map((i) => i.kind).join(",");
    console.log(`${enabled}  ${a.name.padEnd(18)}  ${title.padEnd(32)}  [${inputs}]`);
  }
}

async function cmdModels(args: string[]) {
  if (hasFlag(args, "--refresh")) {
    await refreshModelCatalog({ reason: "manual", onLog: (line) => console.error(line) });
  }
  const models = listModelCatalog(await listCodingAgents().catch(() => []));
  const discovery = readModelDiscoveryCacheSync();
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ models, discovery }, null, 2));
    return;
  }
  if (discovery) {
    console.log(
      `discovery: ${new Date(discovery.refreshedAt).toISOString()} (${discovery.schedule} ${discovery.timeZone})`,
    );
  }
  for (const item of models) {
    const scopes = [item.session ? "session" : null, item.auto ? "auto" : null]
      .filter(Boolean)
      .join(",");
    console.log(`${item.key.padEnd(13)} ${item.defaultModel.padEnd(32)} ${scopes}`);
    console.log(`  models: ${item.models.join(", ")}`);
    if (item.thinkingLevels.length) console.log(`  thinking: ${item.thinkingLevels.join(", ")}`);
  }
}

async function cmdBrowser(args: string[]) {
  const [skills, insightAgents, autoAgents, codingAgents] = await Promise.all([
    listSkillCatalog(),
    listAgents(),
    listAutoAgents(),
    listCodingAgents().catch(() => []),
  ]);
  const browser = buildAgentBrowserTree({ skills, insightAgents, autoAgents, codingAgents });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ browser }, null, 2));
    return;
  }
  console.log("Providers");
  for (const provider of browser.groups.providers) {
    const auto = provider.autoAgents.length ? ` auto: ${provider.autoAgents.join(", ")}` : "";
    console.log(`  ${provider.key} (${provider.defaultModel})${auto}`);
    console.log(`    models: ${provider.models.join(", ")}`);
  }
  console.log("\nInsight agents");
  for (const agent of browser.insightAgents) {
    const enabled = agent.enabled ? "on " : "OFF";
    const skillsText = agent.skills.length ? ` skills: ${agent.skills.map((s) => `$${s}`).join(", ")}` : "";
    console.log(`  ${enabled} ${agent.name} — ${agent.title}${skillsText}`);
  }
  console.log("\nAuto agents");
  for (const agent of browser.autoAgents) {
    const enabled = agent.enabled ? "on " : "OFF";
    const skillsText = agent.skills.length ? ` skills: ${agent.skills.map((s) => `$${s}`).join(", ")}` : "";
    console.log(
      `  ${enabled} ${agent.id} — ${agent.name} [${agent.backend}${agent.model ? `/${agent.model}` : ""}] ${agent.schedule}${skillsText}`,
    );
  }
  console.log(`\nSkills: ${browser.skills.length}`);
  for (const rel of browser.groups.skills.filter((skill) => skill.autoAgents.length || skill.insightAgents.length)) {
    console.log(
      `  $${rel.trigger} -> ${[
        ...rel.autoAgents.map((id) => `auto:${id}`),
        ...rel.insightAgents.map((name) => `agent:${name}`),
      ].join(", ")}`,
    );
  }
}

async function cmdCreateAuto(args: string[]) {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`lfg agents create-auto — create a scheduled auto agent

Usage:
  lfg agents create-auto --name NAME --prompt-file prompt.md --schedule "0 9 * * *"
  lfg agents create-auto --name NAME --prompt "..." --schedule "*/30 * * * *" --backend codex-aisdk --model gpt-5.5

Options:
  --backend aisdk|codex-aisdk|grok|cursor|opencode
  --model MODEL
  --thinking-level LEVEL
  --cwd PATH
  --tool NAME[,NAME]
  --disabled
  --json`);
    return;
  }
  const name = option(args, "--name")?.trim();
  const schedule = option(args, "--schedule")?.trim();
  const promptInline = option(args, "--prompt");
  const promptFile = option(args, "--prompt-file");
  if (!name || !schedule || (!promptInline && !promptFile)) {
    console.error("Usage: lfg agents create-auto --name NAME --prompt|--prompt-file TEXT --schedule CRON");
    process.exit(1);
  }
  const prompt = (promptFile ? await Bun.file(promptFile).text() : promptInline ?? "").trim();
  if (!prompt) {
    console.error("auto agent prompt is empty");
    process.exit(1);
  }
  const backend = (option(args, "--backend") ?? option(args, "--agent") ?? "aisdk").trim();
  if (!(AUTO_AGENT_BACKENDS as readonly string[]).includes(backend)) {
    console.error(`unknown backend "${backend}" (expected one of ${AUTO_AGENT_BACKENDS.join(", ")})`);
    process.exit(1);
  }
  const model = option(args, "--model")?.trim();
  if (backend === "aisdk" && model) {
    const allowed = modelsForAgent("aisdk");
    if (!allowed.includes(model)) {
      console.error(`unknown aisdk model "${model}" (expected one of ${allowed.join(", ")})`);
      process.exit(1);
    }
  }
  if (backend === "grok" && model) {
    const allowed = modelsForAgent("grok");
    if (!allowed.includes(model)) {
      console.error(`unknown grok model "${model}" (expected one of ${allowed.join(", ")})`);
      process.exit(1);
    }
  }
  if (
    (backend === "codex-aisdk" || backend === "opencode" || backend === "cursor") &&
    model &&
    !/^[A-Za-z0-9_.:\/-]{1,120}$/.test(model)
  ) {
    console.error(`invalid ${backend} model name`);
    process.exit(1);
  }
  const thinkingLevel = option(args, "--thinking-level")?.trim();
  if (thinkingLevel) {
    const allowed = thinkingLevelsForAgent(backend);
    if (!allowed || !allowed.includes(thinkingLevel)) {
      console.error(`unknown thinking level "${thinkingLevel}" for ${backend}`);
      process.exit(1);
    }
  }
  const tools = options(args, "--tool").flatMap((value) =>
    value.split(",").map((tool) => tool.trim()).filter(Boolean),
  );
  const agent = await saveAutoAgent({
    name,
    prompt,
    schedule,
    enabled: !hasFlag(args, "--disabled"),
    cwd: option(args, "--cwd"),
    agent: backend as AutoAgentBackend,
    model: model || MODEL_OPTIONS[backend as keyof typeof MODEL_OPTIONS]?.defaultModel,
    thinkingLevel,
    tools: tools.length ? tools : undefined,
  });
  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify({ agent }, null, 2));
    return;
  }
  console.log(`created auto agent ${agent.id} (${agent.agent ?? "aisdk"}${agent.model ? `/${agent.model}` : ""})`);
}

async function cmdRun(args: string[]) {
  let all = false;
  let dryRun = false;
  let name: string | undefined;
  for (const a of args) {
    if (a === "--all") all = true;
    else if (a === "--dry" || a === "--dry-run") dryRun = true;
    else if (!a.startsWith("--")) name = a;
  }

  const log = (line: string) => console.error(line);

  if (all) {
    const results = await runAllAgents({ dryRun, onLog: log });
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (!name) {
    console.error("Usage: lfg agents run <name>|--all\n");
    console.log(HELP);
    process.exit(1);
  }
  const r = await runAgent(name, { dryRun, onLog: log });
  console.log(JSON.stringify(r, null, 2));
}

async function cmdShow(args: string[]) {
  const [name] = args;
  if (!name) {
    console.error("Usage: lfg agents show <name>");
    process.exit(1);
  }
  const a = await loadAgent(name);
  console.log(JSON.stringify(a.frontmatter, null, 2));
  console.log("---");
  console.log(a.body);
}
