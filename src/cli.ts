#!/usr/bin/env bun
const HELP = `omg — run and manage your AI coding agents on your own box

Usage:
  omg serve                        Run the web UI + control server (default :8766)
  omg agents [list|run|show]       Run / inspect insight agents (see 'agents help')
  omg subagent [create|models]      Spawn a managed worker session on any harness
  omg mcp                          Run the omg.dev MCP stdio server
  omg whatsapp [run|sessions]      Run the optional WhatsApp control sidecar
  omg connect <code>               Pair this box to a remote-access relay (EXPERIMENTAL)
  omg setup                        Provision this box (Bun, tmux, service)
  omg update [--check]             Update to the latest release and restart
  omg uninstall [--purge --yes]    Remove omg.dev (preserves sessions/config by default)

Env (read from process env / .env, see .env.example):
  OMG_PORT, OMG_HOST, OMG_REPOS_ROOT  (the older LFG_* spellings still work)

Machine verbs also answer to \`omg computer <verb>\`, which is the documented
spelling: \`omg\` may be this CLI or the omg.dev CLI depending on PATH, and that
form works with either. \`lfg\` remains a working alias for this command.
`;

/**
 * Machine-local verbs are also reachable as `omg computer <verb>`.
 *
 * That is the documented surface, because `omg` may be either this CLI or the
 * omg.dev CLI depending on PATH order, and only one spelling can work in both.
 * The omg.dev CLI routes `computer <verb>` here; this makes the same command
 * work when it is absent and this binary answers to `omg` directly.
 *
 * Bare verbs stay: the service unit and every already-registered MCP config
 * invoke `src/cli.ts serve` / `mcp` directly, and rewriting those would mean
 * migrating third-party agent configs for no user-visible gain.
 */
const COMPUTER_VERBS = new Set([
  "serve",
  "setup",
  "update",
  "uninstall",
  "status",
  "mcp",
  "agents",
  "subagent",
  "subagents",
  "connect",
  "whatsapp",
]);

function unwrapComputerNamespace(argv: string[]): string[] {
  if (argv[0] !== "computer") return argv;
  const verb = argv[1];
  // `omg computer` alone, or a verb this CLI does not have, falls through to
  // normal dispatch so the error names the actual command rather than "computer".
  if (!verb || !COMPUTER_VERBS.has(verb)) return argv;
  // `computer status` is the omg.dev CLI's name for the install summary; this
  // CLI spells that `setup --check`-ish behaviour through its own commands, so
  // map it to the closest thing rather than inventing a second one.
  if (verb === "status") return ["update", "--check", ...argv.slice(2)];
  return argv.slice(1);
}

async function main() {
  // Must run before the first `await import` below: commands read their
  // configuration at module scope, so aliasing after the import would be too
  // late for anything already captured into a module-level const.
  const { applyEnvAliases } = await import("./env-compat.ts");
  applyEnvAliases();

  const [cmd, ...rest] = unwrapComputerNamespace(process.argv.slice(2));
  switch (cmd) {
    case "serve": {
      const { cmdServe } = await import("./commands/serve.ts");
      return await cmdServe();
    }
    case "agents": {
      const { cmdAgents } = await import("./commands/agents.ts");
      return await cmdAgents(rest);
    }
    case "subagent":
    case "subagents": {
      const { cmdSubagent } = await import("./commands/subagent.ts");
      return await cmdSubagent(rest);
    }
    case "mcp": {
      const { cmdMcp } = await import("./commands/mcp.ts");
      return await cmdMcp();
    }
    case "whatsapp": {
      const { cmdWhatsapp } = await import("./commands/whatsapp.ts");
      return await cmdWhatsapp(rest);
    }
    case "connect": {
      const { cmdConnect } = await import("./commands/connect.ts");
      return await cmdConnect(rest);
    }
    case "setup": {
      const { cmdSetup } = await import("./commands/setup.ts");
      return await cmdSetup(rest);
    }
    case "update": {
      const { cmdUpdate } = await import("./commands/update.ts");
      return await cmdUpdate(rest);
    }
    case "uninstall": {
      const { cmdUninstall } = await import("./commands/uninstall.ts");
      return await cmdUninstall(rest);
    }
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
