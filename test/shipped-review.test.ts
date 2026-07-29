import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("shipped session review flow", () => {
  const app = readFileSync("web/src/App.tsx", "utf8");

  test("recent shipped shortcuts open the review surface without resuming", () => {
    expect(app).toContain(
      "onOpenRecentShipped={embedded ? undefined : openShipped}",
    );
    expect(app).not.toContain('toast.message("Resuming shipped session…")');
  });

  test("the first new message is included in the resume request", () => {
    expect(app).toContain("onResumeSession={async (sid, prompt) =>");
    expect(app).toContain("sessionId: sid,\n                    prompt,");
    expect(app).toContain("Sending resumes this session.");
  });
});
