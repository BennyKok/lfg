import { describe, expect, test } from "bun:test";
import { buildFilePatch } from "./session-file-patch";

describe("buildFilePatch", () => {
  test("produces a unified diff and an apply-exactly instruction", () => {
    const result = buildFilePatch({
      displayPath: "videos/shorts/shoot-day.md",
      original: "# Shoot day\n\nold hook\n",
      edited: "# Shoot day\n\nnew hook\n",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain("-old hook");
    expect(result.patch).toContain("+new hook");
    expect(result.message).toContain("videos/shorts/shoot-day.md");
    expect(result.message).toContain("exactly as written");
    expect(result.message).toContain("```diff");
  });

  test("appends the user's note after the patch", () => {
    const result = buildFilePatch({
      displayPath: "a.md",
      original: "one\n",
      edited: "two\n",
      note: "also update the CTA to match",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.endsWith("also update the CTA to match")).toBe(true);
  });

  test("refuses to send an unchanged file", () => {
    const same = "unchanged\n";
    expect(buildFilePatch({ displayPath: "a.md", original: same, edited: same })).toEqual({
      ok: false,
      reason: "unchanged",
    });
  });

  test("refuses a patch that would crowd out the conversation", () => {
    const original = "";
    const edited = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    expect(buildFilePatch({ displayPath: "big.txt", original, edited })).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});
