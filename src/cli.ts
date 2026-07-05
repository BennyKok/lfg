#!/usr/bin/env bun
const HELP = `lfg — run and manage your AI coding agents on your own box

Usage:
  lfg serve                        Run the web UI + control server (default :8766)
  lfg agents [list|run|show]       Run / inspect insight agents (see 'agents help')
  lfg subagent [create|models]      Spawn a managed worker session on any harness
  lfg mcp                          Run the LFG MCP stdio server
  lfg whatsapp [run|sessions]      Run the optional WhatsApp control sidecar
  lfg setup                        Provision this box (Bun, tmux, Tailscale, service)

Env (read from process env / .env, see .env.example):
  LFG_PORT, LFG_HOST, LFG_REPOS_ROOT
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
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
    case "setup": {
      const { cmdSetup } = await import("./commands/setup.ts");
      return await cmdSetup(rest);
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
