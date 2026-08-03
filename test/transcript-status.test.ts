import { describe, expect, test } from "bun:test";
import { isRequestInterruptedMessage } from "../web/src/lib/transcript-status.ts";

describe("transcript status messages", () => {
  test("recognizes Claude's interruption markers", () => {
    expect(isRequestInterruptedMessage({
      role: "user",
      kind: "text",
      text: "[Request interrupted by user]",
    })).toBe(true);
    expect(isRequestInterruptedMessage({
      role: "user",
      kind: "text",
      text: "  [Request interrupted by user for tool use]  ",
    })).toBe(true);
  });

  test("does not relabel ordinary transcript messages", () => {
    expect(isRequestInterruptedMessage({
      role: "user",
      kind: "text",
      text: "Request interrupted by user",
    })).toBe(false);
    expect(isRequestInterruptedMessage({
      role: "assistant",
      kind: "text",
      text: "[Request interrupted by user]",
    })).toBe(false);
  });
});
