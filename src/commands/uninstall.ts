import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installInfo, PATHS, type InstallChannel } from "../config.ts";

type CommandResult = { exitCode: number };

export type UninstallDependencies = {
  platform: NodeJS.Platform;
  home: string;
  root: string;
  channel: InstallChannel;
  which: (name: string) => string | null;
  run: (command: string[]) => Promise<CommandResult>;
  output: (message: string) => void;
};

async function run(command: string[]): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return { exitCode: await child.exited };
}

function defaultDependencies(): UninstallDependencies {
  return {
    platform: process.platform,
    home: homedir(),
    root: PATHS.root,
    channel: installInfo().channel,
    which: name => Bun.which(name),
    run,
    output: message => process.stdout.write(`${message}\n`),
  };
}

function removeOwnedCommand(home: string, root: string): boolean {
  const command = join(home, ".local", "bin", "lfg");
  try {
    if (!lstatSync(command).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const target = resolve(dirname(command), readlinkSync(command));
  if (target !== join(root, "src", "cli.ts")) return false;
  rmSync(command);
  return true;
}

function assertSafePurgeRoot(root: string, home: string): void {
  const resolvedRoot = resolve(root);
  const resolvedHome = resolve(home);
  if (resolvedRoot === "/" || resolvedRoot === resolvedHome || resolvedRoot === dirname(resolvedHome)) {
    throw new Error(`Refusing to purge unsafe LFG root: ${resolvedRoot}`);
  }
  try {
    const manifest = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (manifest.name !== "lfg") throw new Error("not lfg");
  } catch {
    throw new Error(`Refusing to purge ${resolvedRoot}: it is not an LFG installation.`);
  }
}

function removeReleaseApplication(root: string): void {
  for (const entry of readdirSync(root)) {
    if (entry === ".env" || entry === "data") continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

async function cleanupService(deps: UninstallDependencies): Promise<void> {
  if (deps.platform === "linux") {
    const service = join(deps.home, ".config", "systemd", "user", "lfg.service");
    if (existsSync(service)) {
      const stopped = await deps.run(["systemctl", "--user", "disable", "--now", "lfg.service"]);
      if (stopped.exitCode !== 0) throw new Error("Could not stop the LFG user service.");
    }
    rmSync(service, { force: true });
    rmSync(join(deps.home, ".config", "systemd", "user", "lfg-agents.slice"), { force: true });
    const reloaded = await deps.run(["systemctl", "--user", "daemon-reload"]);
    if (reloaded.exitCode !== 0) throw new Error("Could not reload the systemd user manager.");
    return;
  }

  if (deps.platform === "darwin") {
    const service = join(deps.home, "Library", "LaunchAgents", "dev.omg.lfg.plist");
    if (existsSync(service)) {
      const stopped = await deps.run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}`, service]);
      if (stopped.exitCode !== 0) throw new Error("Could not stop the LFG launch agent.");
    }
    rmSync(service, { force: true });
    rmSync(join(deps.home, "Library", "Logs", "lfg.out.log"), { force: true });
    rmSync(join(deps.home, "Library", "Logs", "lfg.err.log"), { force: true });
    return;
  }

  throw new Error(`Unsupported OS: ${deps.platform}`);
}

/**
 * Remove the LFG runtime while preserving user state by default.
 *
 * Setup owns the service, command symlink, MCP registrations, and release
 * application files, so uninstall is their single inverse. Shared tools such
 * as Bun, Tailscale, tmux, and coding-agent CLIs are deliberately untouched.
 */
export async function cmdUninstall(
  args: string[],
  overrides: Partial<UninstallDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies(), ...overrides };
  if (args.includes("--help") || args.includes("-h")) {
    deps.output("Usage: lfg uninstall [--purge --yes]");
    deps.output("");
    deps.output("Removes the service, command, MCP registrations, and application files.");
    deps.output("Sessions and config are preserved unless --purge --yes is supplied.");
    return;
  }
  const unknown = args.find(arg => !["--purge", "--yes"].includes(arg));
  if (unknown) throw new Error(`Unknown uninstall option: ${unknown}`);
  const purge = args.includes("--purge");
  if (purge && !args.includes("--yes")) {
    throw new Error("`lfg uninstall --purge` permanently deletes sessions and config. Re-run with `--yes` to confirm.");
  }
  if (deps.channel === "container") {
    throw new Error("This is a container install. Remove it through the container deployment that owns it.");
  }
  if (purge) assertSafePurgeRoot(deps.root, deps.home);

  deps.output("Stopping and removing the LFG service…");
  await cleanupService(deps);

  for (const cli of ["claude", "codex"]) {
    const binary = deps.which(cli);
    if (binary) await deps.run([binary, "mcp", "remove", "lfg"]);
  }

  removeOwnedCommand(deps.home, deps.root);

  if (purge) {
    rmSync(deps.root, { recursive: true, force: true });
    deps.output("LFG and all of its local data were removed.");
    return;
  }

  if (deps.channel === "release") {
    removeReleaseApplication(deps.root);
    deps.output(`LFG was removed. Sessions and config remain in ${deps.root} for a future reinstall.`);
    deps.output("Shared tools such as Bun, Tailscale, tmux, and coding-agent CLIs were left installed.");
    return;
  }

  deps.output(`LFG was disabled and removed from PATH. Source and data remain in ${deps.root}.`);
  deps.output("Shared tools such as Bun, Tailscale, tmux, and coding-agent CLIs were left installed.");
}
