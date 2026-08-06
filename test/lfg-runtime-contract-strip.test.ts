import { describe, expect, test } from "bun:test";
import {
  lfgRuntimeContract,
  sessionTitleFromPrompt,
  stripLfgRuntimeContract,
  withLfgRuntimeContract,
} from "../src/lfg-capabilities.ts";

describe("stripLfgRuntimeContract", () => {
  test("round-trips whatever withLfgRuntimeContract wrapped", () => {
    const task = "Why am I not seeing the session title correctly in the resume page";
    expect(stripLfgRuntimeContract(withLfgRuntimeContract(task)!)).toBe(task);
  });

  test("drops preamble sitting between the contract and the task marker", () => {
    // Real transcripts carry the MCP server instructions and skill listing after
    // the contract's end marker — all of it is launch boilerplate, not the ask.
    const text = [
      lfgRuntimeContract(),
      "",
      "# MCP Server Instructions",
      "This is LFG's agent capability server.",
      "",
      "=== USER TASK ===",
      "Fix the resume sheet titles.",
      "",
      "Attached file:",
      "- IMG_0993.png",
    ].join("\n");
    expect(stripLfgRuntimeContract(text)).toBe(
      "Fix the resume sheet titles.\n\nAttached file:\n- IMG_0993.png",
    );
  });

  test("strips the contract even when no task marker follows", () => {
    const text = `${lfgRuntimeContract()}\n\nCarry on with the watch loop.`;
    expect(stripLfgRuntimeContract(text)).toBe("Carry on with the watch loop.");
  });

  test("leaves ordinary prompts untouched", () => {
    expect(stripLfgRuntimeContract("Just a normal follow-up")).toBe("Just a normal follow-up");
    expect(stripLfgRuntimeContract("")).toBe("");
  });

  test("keeps the original text when stripping would leave nothing to show", () => {
    // A card titled by the empty string is worse than one titled by boilerplate.
    const contractOnly = `${lfgRuntimeContract()}\n\n=== USER TASK ===\n`;
    expect(stripLfgRuntimeContract(contractOnly)).toBe(contractOnly);
    const unterminated = "=== LFG RUNTIME CONTRACT (capability version 1) ===\n- No end marker";
    expect(stripLfgRuntimeContract(unterminated)).toBe(unterminated);
  });

  test("titles a harness session by the ask, not the envelope", () => {
    // The harness recovers its initial prompt from argv, where the envelope is
    // still attached — this is what the session card shows before a transcript
    // exists, and it was rendering as "=== LFG RUNTIME CONTRACT (capability ve…".
    const wrapped = withLfgRuntimeContract("Fix the resume sheet titles")!;
    expect(sessionTitleFromPrompt(wrapped)).toBe("Fix the resume sheet titles");
  });

  test("session titles flatten and truncate, and stay null when there is no prompt", () => {
    expect(sessionTitleFromPrompt("first line\n\nsecond line")).toBe("first line second line");
    expect(sessionTitleFromPrompt("x".repeat(100))).toHaveLength(72);
    expect(sessionTitleFromPrompt("")).toBeNull();
    expect(sessionTitleFromPrompt(null)).toBeNull();
    expect(sessionTitleFromPrompt("   ")).toBeNull();
  });

  test("survives the whitespace collapsing that card previews apply", () => {
    // Titles flatten to one line; the markers must still be findable after it.
    const flattened = withLfgRuntimeContract("Ship the fix")!.replace(/\s+/g, " ");
    expect(stripLfgRuntimeContract(flattened)).toBe("Ship the fix");
  });
});
