import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  symlinkSync(join(root, "src", "cli.ts"), join(bin, "lfg"));

  const commands: string[][] = [];
  const output: string[] = [];
  const deps: Partial<UninstallDependencies> = {
    platform: "linux",
    home,
    root,
    channel,
    which: name => name === "claude" ? "/usr/bin/claude" : null,
    run: async command => {
      commands.push(command);
      return { exitCode: 0 };
    },
    output: message => output.push(message),
  };
  return { home, root, commands, output, deps };
}

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("lfg uninstall", () => {
  test("removes the runtime but preserves sessions and config", async () => {
    const f = fixture();
    roots.push(f.home);

    await cmdUninstall([], f.deps);

    expect(Bun.file(join(f.root, "src", "cli.ts")).exists()).resolves.toBe(false);
    expect(readFileSync(join(f.root, ".env"), "utf8")).toContain("LFG_PORT");
    expect(readFileSync(join(f.root, "data", "sessions.json"), "utf8")).toBe("important\n");
    expect(Bun.file(join(f.home, ".local", "bin", "lfg")).exists()).resolves.toBe(false);
    expect(f.commands).toEqual([
      ["systemctl", "--user", "disable", "--now", "lfg.service"],
      ["systemctl", "--user", "daemon-reload"],
      ["/usr/bin/claude", "mcp", "remove", "lfg"],
    ]);
    expect(f.output.some(line => line.includes("Sessions and config remain"))).toBe(true);
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
});
