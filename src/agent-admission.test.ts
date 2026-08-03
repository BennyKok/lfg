import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeAgentCount,
  AgentAdmissionController,
  computerAgentAdmissionContext,
} from "./agent-admission.ts";

describe("Computer agent admission", () => {
  test("tracks both launching and working agents", () => {
    expect(
      activeAgentCount([{ busy: true }, { launching: true }, { busy: false }]),
    ).toBe(2);
  });

  test("denies at the plan limit and exposes plan context", () => {
    expect(computerAgentAdmissionContext("free")).toEqual({
      plan: "free",
      limit: 1,
    });
    expect(computerAgentAdmissionContext("computer_5")).toEqual({
      plan: "computer_5",
      limit: 5,
    });
    expect(computerAgentAdmissionContext("computer_10")).toEqual({
      plan: "computer_10",
      limit: 16,
    });
    expect(computerAgentAdmissionContext("computer_20")).toEqual({
      plan: "computer_20",
      limit: 24,
    });
    expect(computerAgentAdmissionContext("computer_early")).toEqual({
      plan: "computer_early",
      limit: 24,
    });
    expect(computerAgentAdmissionContext("computer_trial")).toEqual({
      plan: "computer_trial",
      limit: 1,
    });
    const admission = new AgentAdmissionController();
    expect(admission.tryAcquire(1, [{ busy: true }])).toMatchObject({
      ok: false,
      active: 1,
      reserved: 0,
    });
  });

  test("a completed agent frees a plan slot", () => {
    const admission = new AgentAdmissionController();
    const initial = admission.tryAcquire(1, []);
    expect(initial.ok).toBe(true);
    expect(admission.tryAcquire(1, [])).toMatchObject({
      ok: false,
      active: 0,
      reserved: 1,
    });
    if (initial.ok) initial.release();
    expect(admission.tryAcquire(1, [{ busy: true }])).toMatchObject({
      ok: false,
      active: 1,
    });
    expect(admission.tryAcquire(1, [{ busy: false }])).toMatchObject({
      ok: true,
    });
  });

  test("simultaneous launch attempts cannot oversubscribe a slot", () => {
    const admission = new AgentAdmissionController();
    const results = Array.from({ length: 20 }, () =>
      admission.tryAcquire(1, []),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(admission.reserved).toBe(1);
  });

  test("a launch storm stops exactly at every paid plan ceiling", () => {
    for (const [plan, limit] of [
      ["computer_5", 5],
      ["computer_10", 16],
      ["computer_20", 24],
    ] as const) {
      const admission = new AgentAdmissionController();
      const attempts = Array.from({ length: 40 }, () =>
        admission.tryAcquire(limit, []),
      );
      expect(
        attempts.filter((result) => result.ok),
        plan,
      ).toHaveLength(limit);
      expect(admission.reserved, plan).toBe(limit);
      expect(
        attempts.slice(limit).every((result) => !result.ok),
        plan,
      ).toBe(true);
    }
  });

  test("fails safe to free when a cloud plan is unknown", () => {
    expect(computerAgentAdmissionContext("retired-plan")).toEqual({
      plan: "free",
      limit: 1,
    });
    expect(computerAgentAdmissionContext("")).toBeNull();
  });

  test("the managed plan file can change a live process admission limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "lfg-computer-plan-"));
    const path = join(dir, "computer-plan");
    try {
      writeFileSync(path, "computer_5\n");
      expect(computerAgentAdmissionContext(undefined, path)).toEqual({
        plan: "computer_5",
        limit: 5,
      });
      writeFileSync(path, "free\n");
      expect(computerAgentAdmissionContext(undefined, path)).toEqual({
        plan: "free",
        limit: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
