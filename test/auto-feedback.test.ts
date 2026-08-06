import { describe, expect, test } from "bun:test";
import { buildFindingFeedback } from "../src/auto/runner.ts";
import type { Finding } from "../src/auto/store.ts";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "f1",
    agentId: "a",
    title: "t",
    reasoning: [],
    severity: "low",
    createdAt: 0,
    status: "open",
    ...over,
  };
}

describe("buildFindingFeedback", () => {
  test("a dismissed HIGH finding is never suppressed", () => {
    // The regression this encodes: a daily e2e went red, the finding was
    // dismissed, and the agent was then told not to resurface it — so every
    // subsequent red run was silent and the break went unnoticed for a day.
    const out = buildFindingFeedback([
      finding({ severity: "high", status: "dismissed", title: "Self-hosted Computer e2e FAILED" }),
    ]);
    expect(out).not.toContain("Self-hosted Computer e2e FAILED");
    expect(out).not.toContain("do NOT resurface");
  });

  test("dismissed low/med findings still stick", () => {
    const out = buildFindingFeedback([
      finding({ severity: "low", status: "dismissed", title: "nit: rename a var" }),
      finding({ severity: "med", status: "dismissed", title: "med thing", id: "f2" }),
    ]);
    expect(out).toContain("do NOT resurface");
    expect(out).toContain("nit: rename a var");
    expect(out).toContain("med thing");
  });

  test("high dismissal does not drag low dismissals out with it", () => {
    const out = buildFindingFeedback([
      finding({ severity: "high", status: "dismissed", title: "prod is on fire" }),
      finding({ severity: "low", status: "dismissed", title: "cosmetic", id: "f2" }),
    ]);
    expect(out).toContain("cosmetic");
    expect(out).not.toContain("prod is on fire");
  });

  test("open findings are still listed as already-open", () => {
    const out = buildFindingFeedback([finding({ status: "open", title: "already open thing" })]);
    expect(out).toContain("Already open");
    expect(out).toContain("already open thing");
  });

  test("no findings means no feedback block at all", () => {
    expect(buildFindingFeedback([])).toBe("");
  });
});
