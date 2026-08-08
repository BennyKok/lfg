// What a fresh install calls itself, and what an upgrade leaves alone.
//
// setup.sh picks three names before it does anything: the install directory,
// the systemd unit, and the launchd label. Getting these wrong is not a cosmetic
// bug — pointing a fresh box at ~/lfg or, worse, renaming a working box's unit,
// means the control plane either installs somewhere unexpected or stops.
//
// The rule under test: new boxes get `omg`, and a box that already has the
// pre-rename name keeps it. Nothing is ever migrated implicitly.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SETUP_SH } from "./setup-script-helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Run setup.sh's identity-resolution prologue against a fake $HOME.
 *
 * Sliced by marker rather than by function, because this block is top-level
 * config, not a function. The slice ends at the "Install source:" comment,
 * which is the first line after the names are settled.
 */
function resolveIdentity(
  home: string,
  env: Record<string, string> = {},
): { dir: string; service: string; label: string } {
  const source = readFileSync(SETUP_SH, "utf8");
  const start = source.indexOf("# ---- OMG_* / LFG_* aliasing");
  expect(start, "aliasing prologue not found in scripts/setup.sh").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("# Install source:", start);
  expect(end, "end of the config prologue not found in scripts/setup.sh").toBeGreaterThan(start);

  const script = [
    "set -euo pipefail",
    source.slice(start, end),
    'printf "%s\\n%s\\n%s\\n" "$LFG_DIR" "$SERVICE" "$SERVICE_LABEL"',
  ].join("\n");

  const result = Bun.spawnSync(["bash", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: home, ...env },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const [dir, service, label] = result.stdout.toString().trim().split("\n");
  return { dir, service, label };
}

function fakeHome(opts: { dirs?: string[]; units?: string[]; agents?: string[] } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omg-setup-identity-"));
  roots.push(home);
  for (const dir of opts.dirs ?? []) mkdirSync(join(home, dir), { recursive: true });
  const unitDir = join(home, ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  for (const unit of opts.units ?? []) writeFileSync(join(unitDir, `${unit}.service`), "unit\n");
  const agentDir = join(home, "Library", "LaunchAgents");
  mkdirSync(agentDir, { recursive: true });
  for (const label of opts.agents ?? []) writeFileSync(join(agentDir, `${label}.plist`), "plist\n");
  return home;
}

describe("what a fresh install calls itself", () => {
  test("a clean box installs as omg throughout", () => {
    const home = fakeHome();
    const id = resolveIdentity(home);
    expect(id.dir).toBe(join(home, "omg"));
    expect(id.service).toBe("omg");
    expect(id.label).toBe("dev.omg.serve");
  });

  test("the launchd label does not stutter", () => {
    // dev.omg.omg is the mechanical reverse-DNS answer and reads like a bug.
    expect(resolveIdentity(fakeHome()).label).not.toContain("omg.omg");
  });
});

describe("what an upgrade leaves alone", () => {
  test("a box installed before the rename keeps ~/lfg and lfg.service", () => {
    const home = fakeHome({ dirs: ["lfg"], units: ["lfg"], agents: ["dev.omg.lfg"] });
    const id = resolveIdentity(home);
    // Moving a live install's directory would strip it of data/ and .env and
    // orphan the unit's WorkingDirectory; renaming the unit would stop the
    // running control plane. Neither is worth doing to a working machine.
    expect(id.dir).toBe(join(home, "lfg"));
    expect(id.service).toBe("lfg");
    expect(id.label).toBe("dev.omg.lfg");
  });

  test("an already-migrated box stays on the new names", () => {
    const home = fakeHome({ dirs: ["omg"], units: ["omg"], agents: ["dev.omg.serve"] });
    const id = resolveIdentity(home);
    expect(id.dir).toBe(join(home, "omg"));
    expect(id.service).toBe("omg");
    expect(id.label).toBe("dev.omg.serve");
  });

  test("a box carrying both prefers the new names", () => {
    const home = fakeHome({
      dirs: ["lfg", "omg"],
      units: ["lfg", "omg"],
      agents: ["dev.omg.lfg", "dev.omg.serve"],
    });
    const id = resolveIdentity(home);
    expect(id.dir).toBe(join(home, "omg"));
    expect(id.service).toBe("omg");
    expect(id.label).toBe("dev.omg.serve");
  });
});

describe("OMG_ overrides reach a script that reads LFG_", () => {
  test("OMG_DIR picks the install directory", () => {
    const home = fakeHome();
    expect(resolveIdentity(home, { OMG_DIR: "/opt/custom" }).dir).toBe("/opt/custom");
  });

  test("the pre-rename LFG_DIR still works", () => {
    const home = fakeHome();
    expect(resolveIdentity(home, { LFG_DIR: "/opt/legacy" }).dir).toBe("/opt/legacy");
  });

  test("OMG_ wins when a name is set both ways", () => {
    const home = fakeHome();
    const id = resolveIdentity(home, { OMG_DIR: "/opt/new", LFG_DIR: "/opt/old" });
    expect(id.dir).toBe("/opt/new");
  });

  test("an OMG_ override the script only reads as LFG_ is mirrored across", () => {
    // The script reads $LFG_PORT internally; the mirror is what makes
    // `OMG_PORT=9000 curl ... | bash` do anything at all.
    const source = readFileSync(SETUP_SH, "utf8");
    const start = source.indexOf("# ---- OMG_* / LFG_* aliasing");
    const end = source.indexOf("# Install source:", start);
    const script = [
      "set -euo pipefail",
      source.slice(start, end),
      'printf "%s\\n" "$LFG_PORT"',
    ].join("\n");
    const result = Bun.spawnSync(["bash", "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: fakeHome(), OMG_PORT: "9000" },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("9000");
  });
});
