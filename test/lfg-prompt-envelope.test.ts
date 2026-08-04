import { describe, expect, test } from "bun:test";
import { parseLfgPromptEnvelope } from "../web/src/lib/lfg-prompt-envelope";

describe("parseLfgPromptEnvelope", () => {
  test("separates LFG instructions from the user's task", () => {
    expect(
      parseLfgPromptEnvelope(
        [
          "=== LFG RUNTIME CONTRACT (capability version 2026-08-04.1) ===",
          "- Narrate progress.",
          "- Ship verified work.",
          "=== END LFG RUNTIME CONTRACT ===",
          "",
          "=== USER TASK ===",
          "Make the first message easy to read.",
        ].join("\n"),
      ),
    ).toEqual({
      instructions: "- Narrate progress.\n- Ship verified work.",
      task: "Make the first message easy to read.",
      version: "2026-08-04.1",
    });
  });

  test("leaves ordinary and malformed messages alone", () => {
    expect(parseLfgPromptEnvelope("Just a normal follow-up")).toBeNull();
    expect(parseLfgPromptEnvelope("=== LFG RUNTIME CONTRACT ===\nNo closing marker")).toBeNull();
  });
});
