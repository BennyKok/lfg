// Each agent must only be offered thinking levels its own CLI accepts.
//
// The two failure modes are different and neither is obvious from the code:
//
//   grok: --effort/--reasoning-effort: unknown effort level 'xhigh'; use one of: high, medium, low
//         → a hard exit, so the session never starts
//   pi:   Warning: Invalid thinking level "max". Valid values: off, minimal, low, medium, high, xhigh
//         → a warning, so the session runs and the setting silently never applies
//
// Both were reachable from the picker, which offered every agent the Claude
// list. These assert the property rather than the tables, so a level added to
// the shared vocabulary later can't reintroduce it by being forgotten here.

import { describe, expect, test } from "bun:test";
import {
  CLAUDE_THINKING_LEVELS,
  CODEX_THINKING_LEVELS,
  GROK_THINKING_LEVELS,
  PI_THINKING_LEVELS,
  thinkingLevelsForAgent,
} from "./agent-catalog.ts";
import { claudeEffortFor, grokEffortFor } from "./tmux.ts";

/** Every level any picker can produce, plus the ones stored data still holds. */
const ALL_LEVELS = [
  ...new Set([
    ...CLAUDE_THINKING_LEVELS,
    ...CODEX_THINKING_LEVELS,
    ...GROK_THINKING_LEVELS,
    ...PI_THINKING_LEVELS,
  ]),
];

/** Mirrors piThinkingFor in agents/backends/pi-session.ts. */
function piThinkingFor(level?: string): string | undefined {
  if (!level) return undefined;
  if (level === "off" || level === "none") return "off";
  if (level === "minimal") return "minimal";
  if (["low", "medium", "high", "xhigh"].includes(level)) return level;
  if (level === "max") return "xhigh";
  return undefined;
}

describe("levels offered per agent", () => {
  test("grok is offered only what its CLI accepts", () => {
    expect(thinkingLevelsForAgent("grok")).toEqual(["low", "medium", "high"]);
  });

  test("pi is offered exactly what its CLI lists", () => {
    // Including the "off" and "minimal" the shared Claude list had been hiding.
    expect(thinkingLevelsForAgent("pi")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("Claude and codex are unchanged", () => {
    expect(thinkingLevelsForAgent("claude")).toEqual(CLAUDE_THINKING_LEVELS);
    expect(thinkingLevelsForAgent("codex")).toEqual(CODEX_THINKING_LEVELS);
  });

  test("agents with no reasoning knob still report none", () => {
    expect(thinkingLevelsForAgent("opencode")).toBeNull();
    expect(thinkingLevelsForAgent("copilot")).toBeNull();
  });
});

describe("grokEffortFor", () => {
  test("never emits a level grok would reject", () => {
    const accepted = new Set<string>(GROK_THINKING_LEVELS);
    for (const level of ALL_LEVELS) {
      const effort = grokEffortFor(level);
      expect(effort, `no grok effort for "${level}"`).toBeDefined();
      expect(accepted.has(effort as string), `grok would reject "${effort}"`).toBe(true);
    }
  });

  test("clamps above grok's ceiling instead of dropping", () => {
    // Dropping would silently run at grok's default; clamping honours what a
    // stored xhigh/max meant — as high as this agent goes.
    expect(grokEffortFor("xhigh")).toBe("high");
    expect(grokEffortFor("max")).toBe("high");
  });

  test("passes grok's own levels through, and leaves the default for empty", () => {
    expect(grokEffortFor("low")).toBe("low");
    expect(grokEffortFor("medium")).toBe("medium");
    expect(grokEffortFor("high")).toBe("high");
    expect(grokEffortFor(undefined)).toBeUndefined();
  });
});

describe("piThinkingFor", () => {
  test("never emits a level pi would warn about", () => {
    const accepted = new Set<string>(PI_THINKING_LEVELS);
    for (const level of [...ALL_LEVELS, "none"]) {
      const thinking = piThinkingFor(level);
      expect(thinking, `no pi thinking for "${level}"`).toBeDefined();
      expect(accepted.has(thinking as string), `pi would reject "${thinking}"`).toBe(true);
    }
  });

  test("keeps the levels pi can express that Claude collapses", () => {
    expect(piThinkingFor("off")).toBe("off");
    expect(piThinkingFor("none")).toBe("off");
    expect(piThinkingFor("minimal")).toBe("minimal");
    // claudeEffortFor has to flatten both of those into "low".
    expect(claudeEffortFor("none")).toBe("low");
    expect(claudeEffortFor("minimal")).toBe("low");
  });

  test("clamps above pi's xhigh ceiling", () => {
    expect(piThinkingFor("max")).toBe("xhigh");
    expect(piThinkingFor("xhigh")).toBe("xhigh");
  });
});
