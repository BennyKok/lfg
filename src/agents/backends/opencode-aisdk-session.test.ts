import { describe, expect, test } from "bun:test";
import { answersForIndex, pendingToPrompt } from "./opencode-aisdk-session.ts";

describe("opencode question prompt helpers", () => {
  const pending = {
    id: "que_test",
    sessionID: "ses_test",
    questions: [
      {
        question: "How do you want to handle kimi k3 support?",
        header: "kimi k3 fix scope",
        options: [
          { label: 'Add "kimi" to order (Recommended)', description: "curator fix" },
          { label: "Also hardcode kimi-k3", description: "fallback seed" },
          { label: "Just hardcode kimi-k3", description: "not recommended" },
        ],
      },
    ],
  };

  test("pendingToPrompt maps 0-based options for the web prompt panel", () => {
    const prompt = pendingToPrompt(pending);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toContain("kimi k3");
    expect(prompt!.header).toBe("kimi k3 fix scope");
    expect(prompt!.options.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(prompt!.options[0]!.selected).toBe(true);
    expect(prompt!.options[0]!.label).toContain("Recommended");
  });

  test("pendingToPrompt returns null without options", () => {
    expect(
      pendingToPrompt({
        id: "que_empty",
        questions: [{ question: "hi", options: [] }],
      }),
    ).toBeNull();
  });

  test("answersForIndex builds OpenCode reply payload by option label", () => {
    expect(answersForIndex(pending, 0)).toEqual([
      ['Add "kimi" to order (Recommended)'],
    ]);
    expect(answersForIndex(pending, 1)).toEqual([["Also hardcode kimi-k3"]]);
    expect(answersForIndex(pending, 2)).toEqual([["Just hardcode kimi-k3"]]);
  });

  test("answersForIndex falls back to first option for extra questions", () => {
    const multi = {
      id: "que_multi",
      questions: [
        {
          question: "q1",
          options: [{ label: "A" }, { label: "B" }],
        },
        {
          question: "q2",
          options: [{ label: "X" }, { label: "Y" }],
        },
      ],
    };
    expect(answersForIndex(multi, 1)).toEqual([["B"], ["X"]]);
  });
});
