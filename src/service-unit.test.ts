// Which unit name this box acts on.
//
// The interesting cases are the two ends of the rename: a machine installed
// before it (only `lfg.service`) must keep being restarted and stopped, and a
// machine installed after it (only `omg.service`) must not be silently skipped
// by code that still names the old unit. The second failure is the quiet one —
// `systemctl --user restart lfg.service` on a box that has no such unit exits
// non-zero, and a deploy script that ignores it reports success having
// restarted nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restartCommand } from "./self-update.ts";
import {
  SERVICE_LABEL,
  SERVICE_LABEL_LEGACY,
  installedLaunchAgent,
  installedSystemdUnit,
  restartHint,
  serviceLabel,
  serviceUnitName,
} from "./service-unit.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake $HOME carrying the named systemd units / launch agents. */
function fakeHome(opts: { units?: string[]; agents?: string[] } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omg-service-unit-"));
  cleanup.push(home);
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  for (const name of opts.units ?? []) writeFileSync(join(unitDir, `${name}.service`), "unit\n");
  const agentDir = join(home, "Library", "LaunchAgents");
  mkdirSync(agentDir, { recursive: true });
  for (const label of opts.agents ?? []) writeFileSync(join(agentDir, `${label}.plist`), "plist\n");
  return home;
}

describe("resolving the installed service", () => {
  test("a box installed before the rename keeps its lfg unit", () => {
    const home = fakeHome({ units: ["lfg"] });
    expect(installedSystemdUnit(home)).toBe("lfg");
    expect(serviceUnitName(home)).toBe("lfg");
  });

  test("a box installed after the rename resolves to omg", () => {
    const home = fakeHome({ units: ["omg"] });
    expect(installedSystemdUnit(home)).toBe("omg");
    expect(serviceUnitName(home)).toBe("omg");
  });

  test("a box with neither names omg, so a fresh install creates the new one", () => {
    const home = fakeHome();
    expect(installedSystemdUnit(home)).toBeNull();
    expect(serviceUnitName(home)).toBe("omg");
  });

  test("the new unit wins when an old installer left both behind", () => {
    const home = fakeHome({ units: ["omg", "lfg"] });
    expect(installedSystemdUnit(home)).toBe("omg");
  });

  test("launch agents resolve the same way", () => {
    expect(installedLaunchAgent(fakeHome({ agents: [SERVICE_LABEL_LEGACY] }))).toBe(SERVICE_LABEL_LEGACY);
    expect(installedLaunchAgent(fakeHome({ agents: [SERVICE_LABEL] }))).toBe(SERVICE_LABEL);
    expect(installedLaunchAgent(fakeHome())).toBeNull();
    expect(serviceLabel(fakeHome())).toBe(SERVICE_LABEL);
  });

  test("the launchd label does not stutter", () => {
    // `dev.omg.omg` would be the mechanical reverse-DNS answer and reads like a
    // packaging bug in `launchctl list`.
    expect(SERVICE_LABEL).not.toContain("omg.omg");
  });

  test("the restart hint names a unit this box actually has", () => {
    expect(restartHint("linux", fakeHome({ units: ["lfg"] }))).toBe(
      "systemctl --user restart lfg.service",
    );
    expect(restartHint("linux", fakeHome({ units: ["omg"] }))).toBe(
      "systemctl --user restart omg.service",
    );
    expect(restartHint("darwin", fakeHome({ agents: [SERVICE_LABEL_LEGACY] }))).toContain(
      SERVICE_LABEL_LEGACY,
    );
  });
});

describe("restarting the resolved unit", () => {
  test("restarts omg.service on a box installed after the rename", () => {
    const home = fakeHome({ units: ["omg"] });
    const procRoot = join(home, "proc");
    mkdirSync(procRoot, { recursive: true });

    const command = restartCommand("linux", home, procRoot);
    // The regression this guards: resolving to the legacy name here would
    // restart a unit that does not exist, and the update would appear to work.
    expect(command?.slice(1)).toEqual(["--user", "restart", "omg.service"]);
  });

  test("still restarts lfg.service on a box installed before it", () => {
    const home = fakeHome({ units: ["lfg"] });
    const procRoot = join(home, "proc");
    mkdirSync(procRoot, { recursive: true });

    const command = restartCommand("linux", home, procRoot);
    expect(command?.slice(1)).toEqual(["--user", "restart", "lfg.service"]);
  });
});
