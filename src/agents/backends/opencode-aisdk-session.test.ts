import { describe, expect, test } from "bun:test";
import {
  answersForIndex,
  isTrustedUploadPermission,
  pendingToPrompt,
  permissionToPrompt,
  shouldPublishDraftPart,
  toolPartMessages,
} from "./opencode-aisdk-session.ts";

describe("opencode draft streaming", () => {
  test("does not publish OpenCode's streamed user prompt as an assistant draft", () => {
    const roles = new Map<string, "user" | "assistant">([
      ["msg_user", "user"],
      ["msg_assistant", "assistant"],
    ]);

    expect(
      shouldPublishDraftPart(
        { type: "text", text: "launch prompt", messageID: "msg_user" },
        roles,
      ),
    ).toBe(false);
    expect(
      shouldPublishDraftPart(
        { type: "text", text: "working on it", messageID: "msg_assistant" },
        roles,
      ),
    ).toBe(true);
  });

  test("waits for message role metadata instead of guessing on an unknown part", () => {
    expect(
      shouldPublishDraftPart(
        { type: "text", text: "ambiguous", messageID: "msg_unknown" },
        new Map(),
      ),
    ).toBe(false);
  });
});

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

describe("opencode permission prompt helpers", () => {
  test("trusts only external-directory access scoped to LFG uploads", () => {
    expect(
      isTrustedUploadPermission({
        id: "per_upload",
        permission: "external_directory",
        patterns: ["/tmp/lfg-uploads/*"],
      }),
    ).toBe(true);
    expect(
      isTrustedUploadPermission({
        id: "per_home",
        permission: "external_directory",
        patterns: ["/home/dev/*"],
      }),
    ).toBe(false);
    expect(
      isTrustedUploadPermission({
        id: "per_bash",
        permission: "bash",
        patterns: ["/tmp/lfg-uploads/*"],
      }),
    ).toBe(false);
    expect(
      isTrustedUploadPermission({
        id: "per_escape",
        permission: "external_directory",
        patterns: ["/tmp/lfg-uploads/../private/*"],
      }),
    ).toBe(false);
  });

  test("maps other permissions to explicit allow and deny choices", () => {
    const prompt = permissionToPrompt({
      id: "per_external",
      permission: "external_directory",
      patterns: ["/home/dev/footage/*"],
    });
    expect(prompt.question).toContain("/home/dev/footage/*");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Allow once",
      "Always allow",
      "Deny",
    ]);
  });
});

describe("opencode tool part streaming", () => {
  // OpenCode mutates one part per tool call. The regression this guards: every
  // transcript row was frozen at `read [pending]: {}` because the empty pending
  // snapshot claimed the part id and the append-only index ignored the rest.
  const feed = (states: Array<Record<string, unknown>>) => {
    const emitted = new Set<string>();
    const rows: Array<{ id: string; kind: string; text: string }> = [];
    for (const state of states) {
      for (const m of toolPartMessages({ id: "prt_1", type: "tool", tool: "read", state }, "fb", emitted)) {
        rows.push({ id: m.id ?? "", kind: m.kind, text: m.text ?? "" });
      }
    }
    return rows;
  };

  test("skips the empty pending snapshot", () => {
    expect(feed([{ status: "pending", input: {} }])).toEqual([]);
  });

  test("emits the call once input is known, then the result", () => {
    const rows = feed([
      { status: "pending", input: {} },
      { status: "running", input: { filePath: "/tmp/a.ts" } },
      { status: "completed", input: { filePath: "/tmp/a.ts" }, output: "file body" },
    ]);
    expect(rows).toEqual([
      { id: "prt_1", kind: "tool_use", text: 'read: {\n  "filePath": "/tmp/a.ts"\n}' },
      { id: "prt_1:result", kind: "tool_result", text: "file body" },
    ]);
  });

  test("does not re-emit when the same state is re-sent", () => {
    const running = { status: "running", input: { filePath: "/tmp/a.ts" } };
    expect(feed([running, running, running])).toHaveLength(1);
  });

  test("still emits a call that jumps straight to completed", () => {
    const rows = feed([{ status: "completed", input: { filePath: "/a" }, output: "out" }]);
    expect(rows.map((r) => r.kind)).toEqual(["tool_use", "tool_result"]);
  });

  test("surfaces tool errors as a result row", () => {
    const rows = feed([
      { status: "running", input: { filePath: "/nope" } },
      { status: "error", input: { filePath: "/nope" }, error: "ENOENT" },
    ]);
    expect(rows[1]).toEqual({ id: "prt_1:result", kind: "tool_result", text: "read failed: ENOENT" });
  });

  test("clips runaway tool output", () => {
    const rows = feed([{ status: "completed", input: { a: 1 }, output: "x".repeat(50_000) }]);
    expect(rows[1].text.length).toBeLessThan(4_100);
    expect(rows[1].text.endsWith("[truncated]")).toBe(true);
  });
});
