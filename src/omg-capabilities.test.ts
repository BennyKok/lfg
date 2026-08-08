import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  OMG_CAPABILITIES,
  OMG_CAPABILITY_VERSION,
  omgCapabilityAccess,
  omgRuntimeContract,
  withOmgRuntimeContract,
} from "./omg-capabilities.ts";

describe("OMG runtime capabilities", () => {
  test("injects the product workflow into a normal root task", () => {
    const prompt = withOmgRuntimeContract("Fix the mobile navigation")!;
    expect(prompt).toContain(`capability version ${OMG_CAPABILITY_VERSION}`);
    expect(prompt).not.toContain("omg_output");
    expect(prompt).toContain("omg_input");
    expect(prompt).not.toContain("advisor");
    expect(prompt).toContain("normal assistant messages");
    expect(prompt).toContain("omg_display_image");
    expect(prompt).toContain("omg_display_video");
    // Regression guard: 83ea6d3 split omg_output into native replies plus
    // omg_ship and dropped the shipping bullet entirely, so agents stopped
    // shipping for two days while CI stayed green. Shipping is how finished
    // work reaches the human — it must never fall out of the contract again.
    expect(prompt).toContain("omg_ship");
    expect(prompt).toContain("closeSession:true");
    expect(prompt).toContain("closeSession:false");
    expect(prompt).toContain("Shipped is not deployed");
    expect(prompt).toContain("scripts/land-session.sh");
    expect(prompt).toContain("uncommitted, unmerged, or not deployed");
    expect(prompt).toContain("omg_find_sessions");
    expect(prompt).toContain("omg_close_session");
    expect(prompt).toEndWith("=== USER TASK ===\nFix the mobile navigation");
  });

  test("keeps the runtime contract compact", () => {
    // Headroom is deliberate: a line budget the contract already sits flush
    // against turns every future edit into a choice about which bullet to
    // delete, which is how shipping was lost in the first place.
    expect(omgRuntimeContract().split("\n").length).toBeLessThanOrEqual(12);
    expect(omgRuntimeContract().length).toBeLessThan(2_400);
  });

  test("does not duplicate the contract", () => {
    const once = withOmgRuntimeContract("Do the work")!;
    expect(withOmgRuntimeContract(once)).toBe(once);
  });

  test("does not turn an empty composer into an autonomous turn", () => {
    expect(withOmgRuntimeContract(undefined)).toBeUndefined();
    expect(withOmgRuntimeContract("   ")).toBe("   ");
  });

  test("publishes a bootstrap entry for every promoted workflow", () => {
    expect(OMG_CAPABILITIES.map((item) => item.tool)).toEqual([
      "omg_ship",
      "omg_display_image / omg_display_video",
      "omg_input",
      "omg_find_sessions",
      "omg_close_session",
      "omg_create_subagent / omg_delegate_*",
      "omg_list_auto_agents / omg_save_auto_agent / omg_run_auto_agent",
    ]);
  });

  test("keeps visual display tools without registering omg_output", () => {
    const mcpSource = readFileSync(new URL("./commands/mcp.ts", import.meta.url), "utf8");
    const serveSource = readFileSync(new URL("./commands/serve.ts", import.meta.url), "utf8");
    expect(mcpSource).not.toContain('registerTool(\n    "omg_output"');
    expect(mcpSource).toContain('registerTool(\n    "omg_display_image"');
    expect(mcpSource).toContain('registerTool(\n    "omg_display_video"');
    expect(mcpSource).toContain('registerTool(\n    "omg_ship"');
    expect(mcpSource).not.toContain('registerTool(\n    "omg_ask_question"');
    expect(mcpSource).not.toContain('"advisor"');
    expect(serveSource).not.toContain('/api/voice/consult');
    expect(serveSource).not.toContain('ADVISOR_BRIEF');
  });

  test("reports honest harness access", () => {
    expect(omgCapabilityAccess("aisdk")).toBe("mcp");
    expect(omgCapabilityAccess("codex-aisdk")).toBe("mcp");
    expect(omgCapabilityAccess("opencode")).toBe("mcp");
    expect(omgCapabilityAccess("grok")).toBe("mcp");
    expect(omgCapabilityAccess("cursor")).toBe("mcp");
    expect(omgCapabilityAccess("copilot")).toBe("contract-only");
    expect(omgCapabilityAccess("hermes")).toBe("contract-only");
  });
});
