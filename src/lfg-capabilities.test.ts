import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LFG_CAPABILITIES,
  LFG_CAPABILITY_VERSION,
  lfgCapabilityAccess,
  lfgRuntimeContract,
  withLfgRuntimeContract,
} from "./lfg-capabilities.ts";

describe("LFG runtime capabilities", () => {
  test("injects the product workflow into a normal root task", () => {
    const prompt = withLfgRuntimeContract("Fix the mobile navigation")!;
    expect(prompt).toContain(`capability version ${LFG_CAPABILITY_VERSION}`);
    expect(prompt).not.toContain("lfg_output");
    expect(prompt).toContain("lfg_input");
    expect(prompt).not.toContain("advisor");
    expect(prompt).toContain("normal assistant messages");
    expect(prompt).toContain("lfg_display_image");
    expect(prompt).toContain("lfg_display_video");
    expect(prompt).toContain("scripts/land-session.sh");
    expect(prompt).toContain("lfg_find_sessions");
    expect(prompt).toContain("lfg_close_session");
    expect(prompt).toEndWith("=== USER TASK ===\nFix the mobile navigation");
  });

  test("keeps the runtime contract compact", () => {
    expect(lfgRuntimeContract().split("\n").length).toBeLessThanOrEqual(10);
    expect(lfgRuntimeContract().length).toBeLessThan(2_400);
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
      "lfg_display_image / lfg_display_video",
      "lfg_input",
      "lfg_find_sessions",
      "lfg_close_session",
      "lfg_create_subagent / lfg_delegate_*",
    ]);
  });

  test("keeps visual display tools without registering lfg_output", () => {
    const mcpSource = readFileSync(new URL("./commands/mcp.ts", import.meta.url), "utf8");
    const serveSource = readFileSync(new URL("./commands/serve.ts", import.meta.url), "utf8");
    expect(mcpSource).not.toContain('registerTool(\n    "lfg_output"');
    expect(mcpSource).toContain('registerTool(\n    "lfg_display_image"');
    expect(mcpSource).toContain('registerTool(\n    "lfg_display_video"');
    expect(mcpSource).not.toContain('registerTool(\n    "lfg_ask_question"');
    expect(mcpSource).not.toContain('"advisor"');
    expect(serveSource).not.toContain('/api/voice/consult');
    expect(serveSource).not.toContain('ADVISOR_BRIEF');
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
