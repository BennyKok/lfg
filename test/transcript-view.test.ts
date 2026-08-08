import { describe, expect, test } from "bun:test";
import {
  isOmgOutputTool,
  messagesForTranscriptView,
} from "../web/src/lib/transcript-view.ts";

describe("experimental transcript view", () => {
  const messages = [
    { id: "user-1", role: "user", kind: "text", text: "Ship it" },
    { id: "thinking-1", role: "assistant", kind: "thinking", text: "Planning" },
    { id: "bash-1", role: "assistant", kind: "tool_use", text: "Bash: pwd" },
    {
      id: "output-1",
      role: "assistant",
      kind: "tool_use",
      text: 'mcp__lfg__lfg_output: {"to":"thread","text":"The fix is verified."}',
    },
    { id: "result-1", role: "tool", kind: "tool_result", text: "delivered" },
    { id: "assistant-1", role: "assistant", kind: "text", text: "Done" },
    { id: "artifact-1", role: "assistant", kind: "image", text: "Screenshot" },
  ];

  test("keeps the complete transcript unchanged in the default view", () => {
    expect(messagesForTranscriptView(messages, "full")).toBe(messages);
  });

  test("shows user turns, rendered LFG output, and displayed artifacts only", () => {
    expect(messagesForTranscriptView(messages, "user-lfg-output")).toEqual([
      messages[0],
      {
        ...messages[3],
        id: "output-1:display",
        role: "assistant",
        kind: "text",
        text: "The fix is verified.",
      },
      messages[6],
    ]);
  });

  test("recognizes direct and namespaced LFG output tools", () => {
    expect(isOmgOutputTool({ kind: "tool_use", text: "lfg_output: {}" })).toBe(true);
    expect(isOmgOutputTool({ kind: "tool_use", text: "mcp__lfg__lfg_output: {}" })).toBe(true);
    expect(isOmgOutputTool({ kind: "tool_use", text: "lfg_input: {}" })).toBe(false);
  });

  test("drops output calls without displayable text while retaining their artifact", () => {
    expect(messagesForTranscriptView([
      {
        id: "output-2",
        role: "assistant",
        kind: "tool_use",
        text: 'mcp__lfg__lfg_output: {"to":"session","media":[{"path":"/tmp/a.png"}]}',
      },
      { id: "artifact-2", role: "assistant", kind: "image", text: "Proof" },
    ], "user-lfg-output")).toEqual([
      { id: "artifact-2", role: "assistant", kind: "image", text: "Proof" },
    ]);
  });
});
