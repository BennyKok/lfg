import { describe, expect, test } from "bun:test";
import {
  LFG_CAPABILITIES,
  LFG_CAPABILITY_VERSION,
  lfgCapabilityAccess,
  withLfgRuntimeContract,
} from "./lfg-capabilities.ts";

describe("LFG runtime capabilities", () => {
  test("injects the product workflow into a normal root task", () => {
    const prompt = withLfgRuntimeContract("Fix the mobile navigation")!;
    expect(prompt).toContain(`capability version ${LFG_CAPABILITY_VERSION}`);
    expect(prompt).toContain("lfg_output");
    expect(prompt).toContain("lfg_input");
    expect(prompt).toContain("to:'thread'");
    expect(prompt).toContain("to:'shipped'");
    expect(prompt).toContain("lfg_close_session");
    expect(prompt).toEndWith("=== USER TASK ===\nFix the mobile navigation");
  });

  test("does not duplicate the contract", () => {
    const once = withLfgRuntimeContract("Do the work")!;
    expect(withLfgRuntimeContract(once)).toBe(once);
  });

  test("does not turn an empty composer into an autonomous turn", () => {
    expect(withLfgRuntimeContract(undefined)).toBeUndefined();
    expect(withLfgRuntimeContract("   ")).toBe("   ");
  });

  test("publishes a bootstrap entry for every promoted workflow", () => {
    expect(LFG_CAPABILITIES.map((item) => item.tool)).toEqual([
      "lfg_output",
      "lfg_input",
      "lfg_close_session",
      "lfg_create_subagent / lfg_delegate_*",
    ]);
  });

  test("reports honest harness access", () => {
    expect(lfgCapabilityAccess("aisdk")).toBe("mcp");
    expect(lfgCapabilityAccess("codex-aisdk")).toBe("mcp");
    expect(lfgCapabilityAccess("opencode")).toBe("mcp");
    expect(lfgCapabilityAccess("grok")).toBe("mcp");
    expect(lfgCapabilityAccess("cursor")).toBe("mcp");
    expect(lfgCapabilityAccess("copilot")).toBe("contract-only");
    expect(lfgCapabilityAccess("hermes")).toBe("contract-only");
  });
});
