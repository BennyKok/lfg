import { describe, expect, test } from "bun:test";
import { buildAutoTriagePrompt } from "../web/src/lib/auto-triage.ts";

describe("auto finding triage prompt", () => {
  test("carries every finding and explicitly authorizes grouped execution", () => {
    const prompt = buildAutoTriagePrompt(
      [
        {
          id: "abc123",
          agentId: "repo-review",
          title: "Checkout can submit twice",
          reasoning: ["The button stays enabled"],
          suggest: "Disable it while pending.",
          severity: "high",
        },
        {
          id: "def456",
          agentId: "strategy",
          title: "Consider a card-on-file trial",
          reasoning: [],
          severity: "med",
        },
      ],
      [
        {
          id: "repo-review",
          name: "Repo review",
          cwd: "/home/dev/repos/store",
          project: "store",
        },
        { id: "strategy", name: "Strategy" },
      ],
    );

    expect(prompt).toContain("human explicitly started the Triage & execute shortcut");
    expect(prompt).toContain("linked, visible LFG subagent sessions");
    expect(prompt).toContain("batch related findings instead of creating one child per finding");
    expect(prompt).toContain("snapshot below define this run's scope");
    expect(prompt).toContain("LFG auto finding reference: abc123");
    expect(prompt).toContain("Source repo: /home/dev/repos/store (project store)");
    expect(prompt).toContain("LFG auto finding reference: def456");
    expect(prompt).toContain("pricing, product-direction, destructive, irreversible");
    expect(prompt).toContain("Do not stop after writing a triage plan or launching children");
  });

  test("uses singular copy for one finding", () => {
    const prompt = buildAutoTriagePrompt(
      [
        {
          id: "abc123",
          agentId: "watcher",
          title: "One issue",
          reasoning: [],
          severity: "low",
        },
      ],
      [],
    );

    expect(prompt.startsWith("Triage and execute 1 open LFG auto-agent finding.\n")).toBe(true);
    expect(prompt).toContain("Agent: watcher");
  });
});
