// Which background service this box actually runs under.
//
// The service was installed as `lfg.service` / `dev.omg.lfg` before the rename.
// A fresh install now gets `omg.service` / `dev.omg.serve`, but an existing box
// keeps whatever it already has: renaming a unit means stopping the running
// control plane and hoping the replacement comes up, and there is no reason to
// take that risk on a machine that is working. So nothing is ever migrated
// implicitly — the name is *resolved* from what is on disk.
//
// Every caller that restarts, stops, or names the service goes through here.
// The failure this prevents is silent: `scripts/land-session.sh` used to restart
// a hardcoded `lfg.service`, so on a box installed under the new name every
// future deploy would have reported success while restarting nothing.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** systemd user unit, without the `.service` suffix. */
export const SERVICE_NAME = "omg";
export const SERVICE_NAME_LEGACY = "lfg";

/**
 * launchd label for a fresh install.
 *
 * Not `dev.omg.omg`: the reverse-DNS convention would duplicate the word, which
 * reads like a packaging mistake in `launchctl list`. The thing being supervised
 * is `omg serve`, so the label says so.
 */
export const SERVICE_LABEL = "dev.omg.serve";
export const SERVICE_LABEL_LEGACY = "dev.omg.lfg";

export function systemdUnitPath(name: string, home = homedir()): string {
  return join(home, ".config", "systemd", "user", `${name}.service`);
}

export function launchAgentPath(label: string, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * The systemd unit installed on this box, or null when there is none.
 *
 * The new name wins when both exist, which only happens if a box was installed
 * fresh and then had an older installer run over it.
 */
export function installedSystemdUnit(home = homedir()): string | null {
  for (const name of [SERVICE_NAME, SERVICE_NAME_LEGACY]) {
    if (existsSync(systemdUnitPath(name, home))) return name;
  }
  return null;
}

/** The launchd label installed on this box, or null when there is none. */
export function installedLaunchAgent(home = homedir()): string | null {
  for (const label of [SERVICE_LABEL, SERVICE_LABEL_LEGACY]) {
    if (existsSync(launchAgentPath(label, home))) return label;
  }
  return null;
}

/**
 * The unit name to act on, falling back to the new name when nothing is
 * installed yet — for messages and for an install that is about to create it.
 */
export function serviceUnitName(home = homedir()): string {
  return installedSystemdUnit(home) ?? SERVICE_NAME;
}

/** As above, for launchd. */
export function serviceLabel(home = homedir()): string {
  return installedLaunchAgent(home) ?? SERVICE_LABEL;
}

/** The command a human should run to restart this box's service, for help text. */
export function restartHint(platform = process.platform, home = homedir()): string {
  return platform === "darwin"
    ? `launchctl kickstart -k gui/$(id -u)/${serviceLabel(home)}`
    : `systemctl --user restart ${serviceUnitName(home)}.service`;
}
