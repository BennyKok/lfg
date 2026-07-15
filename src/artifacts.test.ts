import { describe, expect, test } from "bun:test";
import { collapseArtifactRetryMessages } from "./artifacts.ts";

describe("artifact display retry reconciliation", () => {
  test("collapses an identical media retry while preserving transcript order", () => {
    const messages = [
      { id: "text-1", kind: "text", ts: 1, text: "before" },
      { id: "artifact-a", kind: "image", ts: 10_000, name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" },
      { id: "artifact-b", kind: "image", ts: 30_000, name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" },
      { id: "text-2", kind: "text", ts: 40_000, text: "after" },
    ];

    expect(collapseArtifactRetryMessages(messages).map((message) => message.id)).toEqual([
      "text-1",
      "artifact-a",
      "text-2",
    ]);
  });

  test("keeps a deliberate later display and distinct media", () => {
    const base = { kind: "image", name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" };
    const messages = [
      { ...base, id: "artifact-a", ts: 10_000 },
      { ...base, id: "artifact-b", ts: 400_001 },
      { ...base, id: "artifact-c", ts: 410_000, size: 43 },
    ];

    expect(collapseArtifactRetryMessages(messages).map((message) => message.id)).toEqual([
      "artifact-a",
      "artifact-b",
      "artifact-c",
    ]);
  });
});
