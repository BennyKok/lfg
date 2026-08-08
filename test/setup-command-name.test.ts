// Which binaries a setup run puts on PATH, and which name it refuses to take.
//
// Two different programs answer to `omg`: the npm CLI (@omg-dev/cli), and this
// one. When both installed the name, PATH order decided which program `omg`
// meant — so the same command did different things on different machines, and
// the winner could flip after a setup run, in a new shell, with no visible
// cause. `omg setup` printing the deploy CLI's help instead of provisioning
// the box was this bug.
//
// The rule under test: `lfg` is always installed, and `omg` is claimed only
// when no other program already holds it. The npm CLI forwards what it does
// not own to `lfg`, so letting it win loses nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETUP_SH } from "./setup-script-helpers.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Run setup.sh's PATH-exposure block against a fake $HOME and $PATH.
 *
 * `cli.ts` is written executable on purpose. An earlier version of this fixture
 * left it 0644, which made `command -v omg` skip our own symlink — the tests
 * passed while the real script kept the name on every upgraded box.
 */
function exposeCommands(
  options: { otherOmg?: "forwards" | "legacy"; staleOmgLink?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "omg-command-name-"));
  roots.push(root);
  const home = join(root, "home");
  const lfgDir = join(root, "install");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(lfgDir, "src"), { recursive: true });
  writeFileSync(join(lfgDir, "src", "cli.ts"), "#!/usr/bin/env bun\n", { mode: 0o755 });

  // A pre-existing symlink from an install that ran before this change. On a
  // real box ~/.local/bin is first on PATH, so this shadows everything else.
  if (options.staleOmgLink) {
    Bun.spawnSync(["ln", "-sf", join(lfgDir, "src", "cli.ts"), join(home, ".local", "bin", "omg")]);
  }

  // A different program already answering to `omg` — the npm CLI. "forwards"
  // is a version that hands unknown commands to this install (its output is
  // then the local CLI's help); "legacy" is one that only prints its own.
  const extraPath: string[] = [];
  if (options.otherOmg) {
    const dir = join(root, "npm-bin");
    mkdirSync(dir, { recursive: true });
    const reply =
      options.otherOmg === "forwards"
        ? "omg — run and manage your AI coding agents on your own box"
        : "omg — deploy a local project to omg.dev";
    writeFileSync(join(dir, "omg"), `#!/bin/sh\necho "${reply}"\n`, { mode: 0o755 });
    extraPath.push(dir);
  }

  const source = readFileSync(SETUP_SH, "utf8");
  const start = source.indexOf("# ---- 6. expose the command on PATH ----");
  expect(start, "PATH-exposure block not found in scripts/setup.sh").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("install_lfg_mcp()", start);
  expect(end, "end of the PATH-exposure block not found").toBeGreaterThan(start);

  // Pull in the real link_command rather than stubbing it: its ownership rules
  // and this block's name arbitration have to agree, and a stub would let them
  // drift apart silently.
  const linkStart = source.indexOf("link_command() {");
  expect(linkStart, "link_command not found in scripts/setup.sh").toBeGreaterThanOrEqual(0);
  const linkEnd = source.indexOf("\n}", linkStart) + 2;

  const script = [
    "set -euo pipefail",
    'say() { printf "==> %s\\n" "$*"; }',
    'warn() { printf "!! %s\\n" "$*"; }',
    source.slice(linkStart, linkEnd),
    source.slice(start, end),
  ].join("\n");

  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      HOME: home,
      LFG_DIR: lfgDir,
      PATH: [join(home, ".local", "bin"), ...extraPath, "/usr/bin", "/bin"].join(":"),
    },
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);

  const bin = join(home, ".local", "bin");
  return {
    stdout: new TextDecoder().decode(result.stdout),
    lfg: existsSync(join(bin, "lfg")),
    omg: existsSync(join(bin, "omg")) || lstatSync(join(bin, "omg"), { throwIfNoEntry: false }) != null,
  };
}

describe("setup.sh: which command names it installs", () => {
  test("claims omg when nothing else holds the name", () => {
    const result = exposeCommands();
    expect(result.lfg).toBe(true);
    expect(result.omg).toBe(true);
  });

  test("always installs lfg, which is what the npm CLI forwards to", () => {
    expect(exposeCommands({ otherOmg: "forwards" }).lfg).toBe(true);
  });

  test("hands omg to a CLI that forwards back here", () => {
    const result = exposeCommands({ otherOmg: "forwards" });
    expect(result.omg).toBe(false);
    expect(result.stdout).toContain("forwards here");
  });

  test("removes a colliding omg an earlier install left behind", () => {
    // The upgrade path, and the one a `command -v omg` check gets wrong: our
    // own symlink is first on PATH, so the script has to look past itself to
    // notice the npm CLI at all.
    const result = exposeCommands({ otherOmg: "forwards", staleOmgLink: true });
    expect(result.omg).toBe(false);
  });

  test("keeps omg when the other CLI is too old to forward", () => {
    // Surrendering to a CLI that cannot reach this install would take
    // `omg serve` off the box. Better a shadowed npm CLI than a missing
    // command — and a later re-run hands the name over once it can forward.
    const result = exposeCommands({ otherOmg: "legacy" });
    expect(result.omg).toBe(true);
    expect(result.stdout).toContain("cannot forward here yet");
  });

  test("keeps its own omg across a plain re-run", () => {
    // Nothing else holds the name here, so the link we made last time is ours
    // to keep — an upgrade must not strip a working command.
    const result = exposeCommands({ staleOmgLink: true });
    expect(result.omg).toBe(true);
  });
});
