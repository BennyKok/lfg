import { describe, expect, test } from "bun:test";
import { shippedCloseDecision } from "./shipped-lifecycle.ts";

describe("shippedCloseDecision", () => {
  test("honors an explicit agent decision", () => {
    expect(shippedCloseDecision(true, { required: true })).toBe(true);
    expect(shippedCloseDecision(false, { required: true })).toBe(false);
  });

  test("keeps direct and older API callers open when no decision is present", () => {
    expect(shippedCloseDecision(undefined)).toBe(false);
    expect(shippedCloseDecision("true")).toBe(false);
  });

  test("requires MCP agents to decide instead of closing implicitly", () => {
    expect(() => shippedCloseDecision(undefined, { required: true })).toThrow(
      "pass closeSession: true",
    );
  });
});
