import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installInfo, PATHS, type InstallChannel } from "../config.ts";
import { MCP_SERVER_NAME, MCP_SERVER_NAME_LEGACY } from "../coding-agents.ts";
import {
  SERVICE_LABEL,
  SERVICE_LABEL_LEGACY,
  SERVICE_NAME,
  SERVICE_NAME_LEGACY,
} from "../service-unit.ts";

type CommandResult = { exitCode: number };

export type UninstallDependencies = {
  platform: NodeJS.Platform;
  home: string;
  root: string;
  channel: InstallChannel;
  hostsFile: string;
  which: (name: string) => string | null;
  run: (command: string[]) => Promise<CommandResult>;
  output: (message: string) => void;
};

/**
 * Delimiters for the block scripts/setup.sh appends to the hosts file for the
 * named local URL. Keep both spellings in sync with that script: they are the
 * only thing marking which lines are ours to delete.
 */
const HOSTS_BEGIN = "# >>> omg local hostname >>>";
const HOSTS_END = "# <<< omg local hostname <<<";

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
    hostsFile: "/etc/hosts",
    which: name => Bun.which(name),
    run,
    output: message => process.stdout.write(`${message}\n`),
  };
}

/**
 * Remove the command symlinks setup owns.
 *
 * Setup links BOTH `omg` and `lfg` at src/cli.ts, so sweeping only `lfg` left
 * `omg` behind pointing at a file uninstall had just deleted - a dangling
 * symlink on PATH that shadows a later reinstall's own link and fails with a
 * confusing ENOENT rather than "not installed".
 */
function removeOwnedCommands(home: string, root: string): string[] {
  const removed: string[] = [];
  for (const name of ["omg", "lfg"]) {
    const command = join(home, ".local", "bin", name);
    try {
      if (!lstatSync(command).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    // Only ours: a link the user pointed somewhere else stays put.
    const target = resolve(dirname(command), readlinkSync(command));
    if (target !== join(root, "src", "cli.ts")) continue;
    rmSync(command);
    removed.push(name);
  }
  return removed;
}

/** Drop the named-local-URL block setup appended to the hosts file. */
async function removeLocalHostname(deps: UninstallDependencies): Promise<void> {
  let current: string;
  try {
    current = readFileSync(deps.hostsFile, "utf8");
  } catch {
    return;
  }
  const lines = current.split("\n");
  const begin = lines.indexOf(HOSTS_BEGIN);
  const end = lines.indexOf(HOSTS_END);
  if (begin === -1 || end === -1 || end < begin) return;
  const next = [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");

  // Stage then `sudo cp`: cp truncates the destination in place, so /etc/hosts
  // keeps its own owner and mode instead of inheriting the staging file's.
  const staging = join(tmpdir(), `omg-hosts-${process.pid}`);
  writeFileSync(staging, next, { mode: 0o644 });
  const copied = await deps.run(["sudo", "cp", staging, deps.hostsFile]);
  rmSync(staging, { force: true });
  if (copied.exitCode !== 0) {
    deps.output(`Could not update ${deps.hostsFile}. Remove the "${HOSTS_BEGIN}" block by hand.`);
    return;
  }
  deps.output(`Removed the named local URL from ${deps.hostsFile}.`);
}

function assertSafePurgeRoot(root: string, home: string): void {
  const resolvedRoot = resolve(root);
  const resolvedHome = resolve(home);
  if (resolvedRoot === "/" || resolvedRoot === resolvedHome || resolvedRoot === dirname(resolvedHome)) {
    throw new Error(`Refusing to purge unsafe omg.dev root: ${resolvedRoot}`);
  }
  try {
    const manifest = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    // Either package name. This guard is the only thing standing between
    // `--purge` and an `rm -rf` of whatever directory it was pointed at, so it
    // must not start refusing real installs the day the manifest is renamed —
    // the failure would read as "this is not an installation", which is exactly
    // the wrong thing to tell someone about their own install.
    if (manifest.name !== "omg" && manifest.name !== "lfg") throw new Error("unrecognised manifest");
  } catch {
    throw new Error(`Refusing to purge ${resolvedRoot}: it is not an omg.dev installation.`);
  }
}

function removeReleaseApplication(root: string): void {
  for (const entry of readdirSync(root)) {
    if (entry === ".env" || entry === "data") continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

async function cleanupService(deps: UninstallDependencies): Promise<void> {
  // Uninstall sweeps BOTH spellings, unlike everywhere else, which resolves to
  // one. "Remove it" has to mean remove it: a box that was installed under the
  // old name and reinstalled under the new one can carry both units, and
  // cleaning up only the one we would have restarted leaves the other enabled
  // and still starting a server at boot.
  if (deps.platform === "linux") {
    const unitDir = join(deps.home, ".config", "systemd", "user");
    for (const name of [SERVICE_NAME, SERVICE_NAME_LEGACY]) {
      const service = join(unitDir, `${name}.service`);
      if (existsSync(service)) {
        const stopped = await deps.run(["systemctl", "--user", "disable", "--now", `${name}.service`]);
        if (stopped.exitCode !== 0) throw new Error(`Could not stop the ${name} user service.`);
      }
      rmSync(service, { force: true });
      rmSync(join(unitDir, `${name}-agents.slice`), { force: true });
    }
    const reloaded = await deps.run(["systemctl", "--user", "daemon-reload"]);
    if (reloaded.exitCode !== 0) throw new Error("Could not reload the systemd user manager.");
    return;
  }

  if (deps.platform === "darwin") {
    for (const label of [SERVICE_LABEL, SERVICE_LABEL_LEGACY]) {
      const service = join(deps.home, "Library", "LaunchAgents", `${label}.plist`);
      if (existsSync(service)) {
        const stopped = await deps.run(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}`, service]);
        if (stopped.exitCode !== 0) throw new Error(`Could not stop the ${label} launch agent.`);
      }
      rmSync(service, { force: true });
    }
    for (const stem of [SERVICE_NAME, SERVICE_NAME_LEGACY]) {
      rmSync(join(deps.home, "Library", "Logs", `${stem}.out.log`), { force: true });
      rmSync(join(deps.home, "Library", "Logs", `${stem}.err.log`), { force: true });
    }
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

  deps.output("Stopping and removing the omg.dev service…");
  await cleanupService(deps);

  // Both registration names, for the same reason the units are swept twice: an
  // upgraded box can carry the pre-rename entry, and leaving it behind points a
  // still-installed agent CLI at an endpoint that is being deleted.
  for (const cli of ["claude", "codex"]) {
    const binary = deps.which(cli);
    if (!binary) continue;
    for (const name of [MCP_SERVER_NAME, MCP_SERVER_NAME_LEGACY]) {
      await deps.run([binary, "mcp", "remove", name]);
    }
  }

  removeOwnedCommands(deps.home, deps.root);
  await removeLocalHostname(deps);

  if (purge) {
    rmSync(deps.root, { recursive: true, force: true });
    deps.output("omg.dev and all of its local data were removed.");
    return;
  }

  if (deps.channel === "release") {
    removeReleaseApplication(deps.root);
    deps.output(`omg.dev was removed. Sessions and config remain in ${deps.root} for a future reinstall.`);
    deps.output("Shared tools such as Bun, Tailscale, tmux, and coding-agent CLIs were left installed.");
    return;
  }

  deps.output(`omg.dev was disabled and removed from PATH. Source and data remain in ${deps.root}.`);
  deps.output("Shared tools such as Bun, Tailscale, tmux, and coding-agent CLIs were left installed.");
}
