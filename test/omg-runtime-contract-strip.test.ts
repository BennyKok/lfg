import { describe, expect, test } from "bun:test";
import {
  omgRuntimeContract,
  sessionTitleFromPrompt,
  stripOmgRuntimeContract,
  withOmgRuntimeContract,
} from "../src/omg-capabilities.ts";

describe("stripOmgRuntimeContract", () => {
  test("round-trips whatever withOmgRuntimeContract wrapped", () => {
    const task = "Why am I not seeing the session title correctly in the resume page";
    expect(stripOmgRuntimeContract(withOmgRuntimeContract(task)!)).toBe(task);
  });

  test("drops preamble sitting between the contract and the task marker", () => {
    // Real transcripts carry the MCP server instructions and skill listing after
    // the contract's end marker — all of it is launch boilerplate, not the ask.
    const text = [
      omgRuntimeContract(),
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
    expect(stripOmgRuntimeContract(text)).toBe(
      "Fix the resume sheet titles.\n\nAttached file:\n- IMG_0993.png",
    );
  });

  test("strips the contract even when no task marker follows", () => {
    const text = `${omgRuntimeContract()}\n\nCarry on with the watch loop.`;
    expect(stripOmgRuntimeContract(text)).toBe("Carry on with the watch loop.");
  });

  test("leaves ordinary prompts untouched", () => {
    expect(stripOmgRuntimeContract("Just a normal follow-up")).toBe("Just a normal follow-up");
    expect(stripOmgRuntimeContract("")).toBe("");
  });

  test("keeps the original text when stripping would leave nothing to show", () => {
    // A card titled by the empty string is worse than one titled by boilerplate.
    const contractOnly = `${omgRuntimeContract()}\n\n=== USER TASK ===\n`;
    expect(stripOmgRuntimeContract(contractOnly)).toBe(contractOnly);
    const unterminated = "=== LFG RUNTIME CONTRACT (capability version 1) ===\n- No end marker";
    expect(stripOmgRuntimeContract(unterminated)).toBe(unterminated);
  });

  test("titles a harness session by the ask, not the envelope", () => {
    // The harness recovers its initial prompt from argv, where the envelope is
    // still attached — this is what the session card shows before a transcript
    // exists, and it was rendering as "=== LFG RUNTIME CONTRACT (capability ve…".
    const wrapped = withOmgRuntimeContract("Fix the resume sheet titles")!;
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
    const flattened = withOmgRuntimeContract("Ship the fix")!.replace(/\s+/g, " ");
    expect(stripOmgRuntimeContract(flattened)).toBe("Ship the fix");
  });
});
