import { describe, expect, test } from "bun:test";
import { findingReference } from "../web/src/lib/finding-reference.ts";

describe("finding reference", () => {
  test("includes enough context to hand a finding to an existing session", () => {
    expect(
      findingReference(
        {
          id: "abc123",
          title: "The checkout can submit twice",
          reasoning: ["The submit button stays enabled", "Both requests create an order"],
          suggest: "Disable submission while the first request is pending.",
        },
        "Strategy",
      ),
    ).toBe(
      [
        "LFG auto finding reference: abc123",
        "Agent: Strategy",
        "Title: The checkout can submit twice",
        "",
        "Reasoning:",
        "- The submit button stays enabled",
        "- Both requests create an order",
        "",
        "Suggested fix: Disable submission while the first request is pending.",
      ].join("\n"),
    );
  });

  test("omits empty optional sections", () => {
    expect(
      findingReference(
        { id: "def456", title: "Review the slow query", reasoning: [] },
        "Performance",
      ),
    ).toBe(
      [
        "LFG auto finding reference: def456",
        "Agent: Performance",
        "Title: Review the slow query",
      ].join("\n"),
    );
  });
});
