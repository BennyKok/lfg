/**
 * `omg update` — bring this install up to the latest release.
 *
 * The capability already existed twice: the web UI has an update button, and
 * `omg setup` re-provisions and picks up a new release on the way past. Neither
 * is the thing someone reaches for from a terminal. `setup` in particular reads
 * like it might reconfigure the machine, so "how do I just update?" had no
 * obvious answer.
 *
 * This runs the same path the UI button does, so there is one update mechanism
 * rather than a second one that drifts: a git pull for source installs, a
 * release bundle swap otherwise, then a service restart.
 */
import { installInfo, PATHS } from "../config.ts";
import {
  applyReleaseUpdate,
  applySourceUpdate,
  releaseUpdateStatus,
  sourceUpdateStatus,
  type ReleaseInstall,
} from "../self-update.ts";

type UpdateDependencies = {
  root: string;
  install: ReturnType<typeof installInfo>;
  output: (message: string) => void;
};

function defaultDependencies(): UpdateDependencies {
  return {
    root: PATHS.root,
    install: installInfo(),
    output: message => process.stdout.write(`${message}\n`),
  };
}

export async function cmdUpdate(
  args: string[],
  overrides: Partial<UpdateDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies(), ...overrides };

  if (args.includes("--help") || args.includes("-h")) {
    deps.output("Usage: omg update [--check]");
    deps.output("");
    deps.output("Updates this installation to the latest release and restarts the service.");
    deps.output("  --check   report what an update would do, and change nothing");
    return;
  }
  const unknown = args.find(arg => !["--check"].includes(arg));
  if (unknown) throw new Error(`Unknown update option: ${unknown}`);
  const checkOnly = args.includes("--check");

  const { channel } = deps.install;
  if (channel !== "source" && channel !== "release") {
    // A container image is rebuilt and redeployed, not updated in place; saying
    // so is more useful than failing halfway through swapping files.
    throw new Error(
      `This is a ${channel} install. Update it through the deployment that owns it.`,
    );
  }

  if (checkOnly) {
    const status = channel === "source"
      ? await sourceUpdateStatus(deps.root)
      : await releaseUpdateStatus(deps.root, deps.install as ReleaseInstall, true);
    if (status.state === "blocked") {
      deps.output(`Cannot update: ${status.message}`);
      return;
    }
    if (status.state === "available") {
      deps.output(`Update available: ${status.message}`);
      return;
    }
    deps.output(status.message || "Already up to date.");
    return;
  }

  deps.output("Checking for an update…");
  const result = channel === "source"
    ? await applySourceUpdate(deps.root)
    : await applyReleaseUpdate(deps.root, deps.install as ReleaseInstall);

  if (result.status.state === "blocked") {
    throw new Error(result.status.message);
  }
  if (!result.updated) {
    deps.output(result.status.message || "Already up to date.");
    return;
  }
  deps.output(`Updated. ${result.status.message ?? ""}`.trim());
  deps.output("Restarting the service…");
}
