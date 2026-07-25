import { listAgents, loadAgent } from "../agents/registry.ts";
import { runAgent, runAllAgents } from "../agents/runner.ts";
import { listAutoAgents } from "../auto/store.ts";
import { autoCreate, cmdAutoAgents, hasFlag } from "./agents-auto.ts";
import {
  buildAgentBrowserTree,
  listModelCatalog,
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
  lfg agents auto <cmd>           Create + manage auto agents (see 'agents auto help')
  lfg agents run --all            Run every enabled agent (cron path)
  lfg agents run <name>           Run a single agent
  lfg agents run <name> --dry     Build the prompt only, don't call claude
  lfg agents show <name>          Print agent frontmatter + body

Auto agents (scheduled watchers → findings):
  lfg agents auto new "watch our deps for CVEs"   Compose a whole agent from one line
  lfg agents auto list                            Schedule, last run, next run
  lfg agents auto run <id>                        Run one now
  lfg agents auto findings --status open          What they surfaced
  lfg agents auto help                            Full lifecycle reference
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
    case "auto":
      return cmdAutoAgents(rest);
    // Back-compat alias for the original explicit-flags creator, which now
    // lives at `lfg agents auto create`.
    case "create-auto":
      return autoCreate(rest);
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
