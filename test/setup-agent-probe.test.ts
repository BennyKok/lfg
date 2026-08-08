// Probing for an agent CLI must not be able to abort the install.
//
// This shipped broken in v0.1.315. The probe was written as
//
//     command -v codex >/dev/null 2>&1; ensure_agent codex "$FLAG" "$?"
//
// which reads as "check, then report the result" and is not: under
// `set -euo pipefail` a probe returning non-zero ends the script. Setup died on
// the first agent that was not installed — i.e. on essentially every real
// machine — with "setup failed at line 472" and no explanation.
//
// It survived review and a full local run because the development box happened
// to have every agent CLI installed, so no probe ever returned non-zero. The
// case worth testing is the empty machine, not the fully-equipped one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETUP_SH, extractFunctionSource } from "./setup-script-helpers.ts";

/**
 * Run the agent-detection block with a chosen set of CLIs "installed".
 * Returns the reported ready/missing lists, or null if the script aborted.
 */
function probeAgents(present: string[]): { ready: string[]; missing: string[] } | null {
  const source = readFileSync(SETUP_SH, "utf8");
  const start = source.indexOf("AGENTS_READY=()");
  const end = source.indexOf("# ---- 4. fetch", start);
  expect(start, "agent block not found").toBeGreaterThanOrEqual(0);
  expect(end, "end of agent block not found").toBeGreaterThan(start);

  const script = [
    // The real script's failure mode only exists under these flags.
    "set -euo pipefail",
    'say() { :; }',
    'warn() { :; }',
    'ensure_path_line() { :; }',
    'BUN_BIN=/bin/true',
    'LFG_INSTALL_CLAUDE=0 LFG_INSTALL_CODEX=0 LFG_INSTALL_OPENCODE=0',
    'LFG_INSTALL_GROK=0 LFG_INSTALL_CURSOR=0 LFG_INSTALL_COPILOT=0',
    'LFG_COPILOT_VERSION=latest',
    // Stub `command` so only the chosen CLIs look installed.
    `PRESENT="${present.join(" ")}"`,
    `command() {
       if [ "\${1:-}" = "-v" ]; then
         case " $PRESENT " in *" \${2} "*) return 0 ;; *) return 1 ;; esac
       fi
       builtin command "$@"
     }`,
    source.slice(start, end),
    'printf "READY:%s\\n" "$(IFS=,; echo "${AGENTS_READY[*]-}")"',
    'printf "MISSING:%s\\n" "$(IFS=,; echo "${AGENTS_MISSING[*]-}")"',
  ].join("\n");

  const result = Bun.spawnSync(["bash", "-c", script]);
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0) return null;
  const pick = (prefix: string) =>
    (stdout.split("\n").find(l => l.startsWith(prefix))?.slice(prefix.length) ?? "")
      .split(",")
      .filter(Boolean);
  return { ready: pick("READY:"), missing: pick("MISSING:") };
}

describe("agent detection", () => {
  // The regression, stated plainly.
  test("a machine with no agent CLIs does not abort setup", () => {
    const result = probeAgents([]);
    expect(result, "setup aborted while probing for agents").not.toBeNull();
    expect(result!.ready).toEqual([]);
    expect(result!.missing).toContain("codex");
    expect(result!.missing).toContain("claude");
  });

  test("a machine with every agent reports them all ready", () => {
    const result = probeAgents(["claude", "codex", "opencode", "grok", "cursor-agent", "copilot"]);
    expect(result).not.toBeNull();
    expect(result!.ready).toContain("claude");
    expect(result!.ready).toContain("codex");
    expect(result!.missing).toEqual([]);
  });

  // The realistic middle: some installed, some not. This is the shape that was
  // broken, and the one a fresh user actually has.
  test("a partial install is reported without aborting", () => {
    const result = probeAgents(["claude"]);
    expect(result, "setup aborted on the first missing agent").not.toBeNull();
    expect(result!.ready).toEqual(["claude"]);
    expect(result!.missing).toContain("codex");
    expect(result!.missing).toContain("opencode");
  });

  test("hermes is not probed for at all any more", () => {
    const result = probeAgents([]);
    expect(result).not.toBeNull();
    expect([...result!.ready, ...result!.missing]).not.toContain("hermes");
  });

  // Guards the specific construct, so the shape cannot come back by hand.
  test("no probe result is passed through $? in a bare statement", () => {
    const source = readFileSync(SETUP_SH, "utf8");
    expect(source).not.toMatch(/command -v \w+ >\/dev\/null 2>&1;\s*ensure_agent/);
    expect(extractFunctionSource("ensure_agent")).toContain('if "$@"');
  });
});
