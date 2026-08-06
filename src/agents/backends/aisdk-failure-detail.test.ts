// On 2026-08-06 three aisdk sessions died within 90s of each other and the only
// record was:
//
//   aisdk-session turn ended with error: error_during_execution
//
// No reason, and no session id — just a pid. The cause was that the reporting
// line read `msg.result`, which exists ONLY on the Agent SDK's success result;
// the error variant (SDKResultError) has no `result`, so the `??` always fell
// through to the bare subtype and every explanatory field was dropped.
import { describe, expect, test } from "bun:test";
import { describeAisdkFailure } from "./aisdk-session.ts";

describe("describeAisdkFailure", () => {
  test("recovers the reason from the real SDKResultError shape", () => {
    // Exactly the shape that used to print nothing but "error_during_execution".
    const line = describeAisdkFailure({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      stop_reason: null,
      terminal_reason: "prompt_too_long",
      errors: ["input length 231043 exceeds the 200000 token limit"],
      permission_denials: [],
      num_turns: 12,
      duration_ms: 8421,
    });

    expect(line).toContain("error_during_execution");
    expect(line).toContain("terminal_reason=prompt_too_long");
    expect(line).toContain("input length 231043 exceeds the 200000 token limit");
    expect(line).toContain("num_turns=12");
    // The old implementation produced only the subtype; anything longer proves
    // the detail actually survived.
    expect(line).not.toBe("error_during_execution");
  });

  test("names the tools when a turn ends on refused permissions", () => {
    const line = describeAisdkFailure({
      subtype: "error_during_execution",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "a", tool_input: {} },
        { tool_name: "Bash", tool_use_id: "b", tool_input: {} },
        { tool_name: "Write", tool_use_id: "c", tool_input: {} },
      ],
    });
    expect(line).toContain("permission_denials=3");
    expect(line).toContain("Bash");
    expect(line).toContain("Write");
    // Deduplicated rather than repeating the same tool per denial.
    expect(line.match(/Bash/g)).toHaveLength(1);
  });

  test("survives junk without throwing away the subtype", () => {
    // The failure path is the worst possible place to throw: it would destroy
    // the diagnostic we're here to emit.
    const circular: Record<string, unknown> = { subtype: "error_max_turns" };
    circular.self = circular;
    expect(() => describeAisdkFailure(circular)).not.toThrow();
    expect(describeAisdkFailure(circular)).toContain("error_max_turns");

    expect(describeAisdkFailure({})).toBe("unknown");
    expect(
      describeAisdkFailure({ subtype: "error_max_turns", errors: null, permission_denials: "nope" }),
    ).toBe("error_max_turns");
  });

  test("still reports a stringy result if the SDK moves the field back", () => {
    expect(describeAisdkFailure({ subtype: "error_during_execution", result: "boom" })).toContain(
      "result=boom",
    );
    // ...and does not emit the "[object Object]" the old String() call produced.
    const objectResult = describeAisdkFailure({
      subtype: "error_during_execution",
      result: { message: "boom" },
    });
    expect(objectResult).toContain('result={"message":"boom"}');
    expect(objectResult).not.toContain("[object Object]");
  });
});
