import { describe, expect, test } from "bun:test";
import { buildChatRenderItems } from "../web/src/lib/chat-render-items.ts";

describe("chat render items", () => {
  test("renders an LFG display result in place of its generic tool call", () => {
    const items = buildChatRenderItems([
      { id: "tool-1", kind: "tool_use", text: "mcp__lfg__lfg_display_image: {\"path\":\"/tmp/a.png\"}", ts: 10 },
      { id: "artifact-1", kind: "image", text: "Screenshot", ts: 11 },
      { id: "text-1", kind: "text", text: "Done", ts: 12 },
    ]);

    expect(items.map((item) => item.type)).toEqual(["artifact_tool", "msg"]);
    expect(items[0]).toMatchObject({
      type: "artifact_tool",
      tool: { id: "tool-1" },
      message: { id: "artifact-1" },
    });
  });

  test("keeps preceding tools while consuming only the matching display call", () => {
    const items = buildChatRenderItems([
      { id: "tool-1", kind: "tool_use", text: "Bash: pwd", ts: 10 },
      { id: "tool-2", kind: "tool_use", text: "lfg_display_video: {\"path\":\"/tmp/a.mp4\"}", ts: 11 },
      { id: "artifact-1", kind: "video", text: "Recording", ts: 12 },
    ]);

    expect(items.map((item) => item.type)).toEqual(["tools", "artifact_tool"]);
    expect(items[0]).toMatchObject({ type: "tools", items: [{ id: "tool-1" }] });
  });

  test("pairs HTML publishes and leaves unrelated media standalone", () => {
    const paired = buildChatRenderItems([
      { id: "tool-1", kind: "tool_use", text: "mcp__lfg__lfg_publish_artifact: {}", ts: 10 },
      { id: "artifact-1", kind: "html", text: "Dashboard", ts: 11 },
    ]);
    const standalone = buildChatRenderItems([
      { id: "tool-2", kind: "tool_use", text: "Bash: screenshot", ts: 10 },
      { id: "artifact-2", kind: "image", text: "Screenshot", ts: 11 },
    ]);

    expect(paired[0]?.type).toBe("artifact_tool");
    expect(standalone.map((item) => item.type)).toEqual(["tools", "msg"]);
  });
});
