import { describe, expect, test } from "bun:test";
import { resolveResumeModel } from "./resume-model.ts";

describe("resume model identity", () => {
  test("stored backend model wins over the current composer", () => {
    expect(resolveResumeModel("aisdk", "opus", "gpt-5.6-sol")).toBe("opus");
    expect(resolveResumeModel("codex-aisdk", "gpt-5.6-sol", "opus")).toBe("gpt-5.6-sol");
  });

  test("an incompatible request falls back within the resolved backend family", () => {
    expect(["fable", "opus", "sonnet", "haiku"]).toContain(
      resolveResumeModel("aisdk", null, "gpt-5.6-sol"),
    );
  });
});
