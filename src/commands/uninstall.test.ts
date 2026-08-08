import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdUninstall, type UninstallDependencies } from "./uninstall.ts";

function fixture(channel: UninstallDependencies["channel"] = "release") {
  const home = mkdtempSync(join(tmpdir(), "lfg-uninstall-"));
  const root = join(home, "lfg");
  const bin = join(home, ".local", "bin");
  const units = join(home, ".config", "systemd", "user");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(units, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"lfg"}\n');
  writeFileSync(join(root, "src", "cli.ts"), "#!/usr/bin/env bun\n");
  writeFileSync(join(root, ".env"), "LFG_PORT=8766\n");
  writeFileSync(join(root, "data", "sessions.json"), "important\n");
  writeFileSync(join(units, "lfg.service"), "service\n");
  writeFileSync(join(units, "lfg-agents.slice"), "slice\n");
  // Setup links both names at the same CLI; uninstall has to sweep both.
  symlinkSync(join(root, "src", "cli.ts"), join(bin, "lfg"));
  symlinkSync(join(root, "src", "cli.ts"), join(bin, "omg"));

  // Always point at a temp hosts file. Defaulting to the real /etc/hosts made
  // the suite read the developer's machine, so it passed or failed depending on
  // whether that machine had ever run setup.
  const hostsFile = join(home, "hosts");
  writeFileSync(
    hostsFile,
    [
      "127.0.0.1\tlocalhost",
      "::1\tip6-localhost",
      "# >>> omg local hostname >>>",
      "127.0.0.1\tomg.local",
      "# <<< omg local hostname <<<",
      "10.0.0.5\tkeep.example",
      "",
    ].join("\n"),
  );

  const commands: string[][] = [];
  const output: string[] = [];
  const deps: Partial<UninstallDependencies> = {
    platform: "linux",
    home,
    root,
    channel,
    hostsFile,
    which: name => name === "claude" ? "/usr/bin/claude" : null,
    run: async command => {
      commands.push(command);
      // Emulate the one command uninstall depends on for its effect, so the
      // hosts rewrite is observable rather than merely recorded.
      if (command[0] === "sudo" && command[1] === "cp") {
        copyFileSync(command[2]!, command[3]!);
      }
      return { exitCode: 0 };
    },
    output: message => output.push(message),
  };
  return { home, root, hostsFile, commands, output, deps };
}

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("omg uninstall", () => {
  test("removes the runtime but preserves sessions and config", async () => {
    const f = fixture();
    roots.push(f.home);

    await cmdUninstall([], f.deps);

    expect(Bun.file(join(f.root, "src", "cli.ts")).exists()).resolves.toBe(false);
    expect(readFileSync(join(f.root, ".env"), "utf8")).toContain("LFG_PORT");
    expect(readFileSync(join(f.root, "data", "sessions.json"), "utf8")).toBe("important\n");
    expect(Bun.file(join(f.home, ".local", "bin", "lfg")).exists()).resolves.toBe(false);
    // The hosts rewrite is asserted separately; its staging path is pid-derived.
    expect(f.commands.filter(command => command[0] !== "sudo")).toEqual([
      ["systemctl", "--user", "disable", "--now", "lfg.service"],
      ["systemctl", "--user", "daemon-reload"],
      // Both registration names: an upgraded box can still carry the pre-rename
      // entry, and leaving it points the CLI at an endpoint being deleted.
      ["/usr/bin/claude", "mcp", "remove", "omg"],
      ["/usr/bin/claude", "mcp", "remove", "lfg"],
    ]);
    expect(f.output.some(line => line.includes("Sessions and config remain"))).toBe(true);
  });

  test("removes both units, so a reinstalled box has nothing left enabled", async () => {
    const f = fixture();
    roots.push(f.home);
    // A box installed before the rename and reinstalled after it carries both.
    // Sweeping only the resolved one leaves the other enabled and still
    // starting a server at boot — "uninstall" has to actually uninstall.
    const units = join(f.home, ".config", "systemd", "user");
    writeFileSync(join(units, "omg.service"), "service\n");
    writeFileSync(join(units, "omg-agents.slice"), "slice\n");

    await cmdUninstall([], f.deps);

    // The hosts rewrite is asserted separately; its staging path is pid-derived.
    expect(f.commands.filter(command => command[0] !== "sudo")).toEqual([
      ["systemctl", "--user", "disable", "--now", "omg.service"],
      ["systemctl", "--user", "disable", "--now", "lfg.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["/usr/bin/claude", "mcp", "remove", "omg"],
      ["/usr/bin/claude", "mcp", "remove", "lfg"],
    ]);
    for (const leftover of ["omg.service", "lfg.service", "omg-agents.slice", "lfg-agents.slice"]) {
      expect(Bun.file(join(units, leftover)).exists()).resolves.toBe(false);
    }
  });

  test("requires explicit confirmation before deleting local data", async () => {
    const f = fixture();
    roots.push(f.home);

    await expect(cmdUninstall(["--purge"], f.deps)).rejects.toThrow("--yes");
    expect(readFileSync(join(f.root, "data", "sessions.json"), "utf8")).toBe("important\n");

    await cmdUninstall(["--purge", "--yes"], f.deps);
    expect(Bun.file(f.root).exists()).resolves.toBe(false);
    expect(f.output.at(-1)).toContain("all of its local data");
  });

  test("does not delete a source checkout", async () => {
    const f = fixture("source");
    roots.push(f.home);

    await cmdUninstall([], f.deps);

    expect(Bun.file(join(f.root, "src", "cli.ts")).exists()).resolves.toBe(true);
    expect(f.output.some(line => line.includes("Source and data remain"))).toBe(true);
  });

  test("refuses to remove container-owned installs", async () => {
    const f = fixture("container");
    roots.push(f.home);
    await expect(cmdUninstall([], f.deps)).rejects.toThrow("container deployment");
    expect(f.commands).toEqual([]);
  });

  test("help is read-only", async () => {
    const f = fixture();
    roots.push(f.home);
    await cmdUninstall(["--help"], f.deps);
    expect(f.commands).toEqual([]);
    expect(Bun.file(join(f.root, "src", "cli.ts")).exists()).resolves.toBe(true);
    expect(f.output[0]).toContain("Usage: lfg uninstall");
  });

  test("does not claim success when the service cannot stop", async () => {
    const f = fixture();
    roots.push(f.home);
    f.deps.run = async command => {
      f.commands.push(command);
      return { exitCode: 1 };
    };
    await expect(cmdUninstall([], f.deps)).rejects.toThrow("Could not stop");
    expect(Bun.file(join(f.root, "src", "cli.ts")).exists()).resolves.toBe(true);
  });

  // Setup links `omg` and `lfg` at the same CLI. Sweeping only `lfg` left `omg`
  // dangling on PATH, pointing at a file uninstall had just deleted.
  test("removes both command names, not just the legacy one", async () => {
    const f = fixture();
    roots.push(f.home);

    await cmdUninstall([], f.deps);

    expect(existsSync(join(f.home, ".local", "bin", "omg"))).toBe(false);
    expect(existsSync(join(f.home, ".local", "bin", "lfg"))).toBe(false);
  });

  test("leaves a command symlink it does not own", async () => {
    const f = fixture();
    roots.push(f.home);
    const foreign = join(f.home, ".local", "bin", "omg");
    rmSync(foreign);
    symlinkSync("/somewhere/else/cli.ts", foreign);

    await cmdUninstall([], f.deps);

    expect(readlinkSync(foreign)).toBe("/somewhere/else/cli.ts");
  });

  test("removes the named local URL block and nothing around it", async () => {
    const f = fixture();
    roots.push(f.home);

    await cmdUninstall([], f.deps);

    const hosts = readFileSync(f.hostsFile, "utf8");
    expect(hosts).not.toContain("omg.local");
    expect(hosts).not.toContain("omg local hostname");
    // Neighbouring entries are the user's, and must survive untouched.
    expect(hosts).toContain("127.0.0.1\tlocalhost");
    expect(hosts).toContain("::1\tip6-localhost");
    expect(hosts).toContain("10.0.0.5\tkeep.example");
  });

  test("leaves a hosts file that has no OMG block alone", async () => {
    const f = fixture();
    roots.push(f.home);
    const original = "127.0.0.1\tlocalhost\n192.168.1.9\tnas.example\n";
    writeFileSync(f.hostsFile, original);

    await cmdUninstall([], f.deps);

    expect(readFileSync(f.hostsFile, "utf8")).toBe(original);
    expect(f.commands.some(command => command[0] === "sudo")).toBe(false);
  });
});
