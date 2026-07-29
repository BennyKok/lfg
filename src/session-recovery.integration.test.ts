import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODING_AGENT_ADAPTERS,
  DURABLE_RECOVERY_AGENT_KINDS,
  SESSION_AGENT_KINDS,
} from "./coding-agent-adapters.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function run(cmd: string[], env?: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd,
    cwd: import.meta.dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>, stream: "stdout" | "stderr"): string {
  return new TextDecoder().decode(result[stream]);
}

describe("session recovery integration", () => {
  test("every coding agent has an explicit recovery contract", () => {
    expect(Object.keys(CODING_AGENT_ADAPTERS).sort()).toEqual([...SESSION_AGENT_KINDS].sort());
    expect([...DURABLE_RECOVERY_AGENT_KINDS].sort()).toEqual([
      "aisdk",
      "claude",
      "codex",
      "codex-aisdk",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(CODING_AGENT_ADAPTERS.copilot.recovery).toBe("process-bound");
  });

  test("every durable backend hands its recovery id across the tmux process boundary", () => {
    const root = tempRoot("lfg-recovery-launch-");
    const fakeBin = join(root, "bin");
    const capture = join(root, "tmux-argv.json");
    const fakeTmux = join(fakeBin, "tmux");
    const fakeHome = join(root, "home");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(fakeTmux, [
      "#!/usr/bin/env bun",
      "const capture = process.env.LFG_TEST_TMUX_CAPTURE;",
      "if (!capture) process.exit(2);",
      "await Bun.write(capture, JSON.stringify(process.argv.slice(2)));",
    ].join("\n"));
    chmodSync(fakeTmux, 0o755);

    const resume = "33333333-3333-4333-8333-333333333333";
    for (const agent of DURABLE_RECOVERY_AGENT_KINDS) {
      rmSync(capture, { force: true });
      const result = run([
        process.execPath,
        join(import.meta.dir, "test-support", "recovery-launch-process.ts"),
        agent,
        root,
        resume,
      ], {
        HOME: fakeHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        LFG_TEST_TMUX_CAPTURE: capture,
      });

      expect(result.exitCode, `${agent}: ${output(result, "stderr")}`).toBe(0);
      const argv = JSON.parse(readFileSync(capture, "utf8")) as string[];
      expect(argv, agent).toContain("new-session");
      if (agent === "claude" || agent === "aisdk") {
        const at = argv.indexOf("--session");
        expect(argv.slice(at, at + 2), agent).toEqual(["--session", resume]);
      } else {
        const at = argv.indexOf("--resume");
        expect(argv.slice(at, at + 2), agent).toEqual(["--resume", resume]);
      }
    }
  });

  test("a fresh process rehydrates the roster written by a previous process", () => {
    const root = tempRoot("lfg-registry-restart-");
    const helper = join(import.meta.dir, "test-support", "managed-registry-process.ts");

    const writer = run([process.execPath, helper, "write", root]);
    expect(writer.exitCode, output(writer, "stderr")).toBe(0);

    const reader = run([process.execPath, helper, "read", root]);
    expect(reader.exitCode, output(reader, "stderr")).toBe(0);
    expect(JSON.parse(output(reader, "stdout"))).toEqual([
      expect.objectContaining({
        tmuxName: "lfg-cross-process",
        sessionId: "11111111-1111-4111-8111-111111111111",
        nativeSessionId: "22222222-2222-4222-8222-222222222222",
        title: "Survives a real process restart",
        launchState: "running",
      }),
    ]);
  });
});
