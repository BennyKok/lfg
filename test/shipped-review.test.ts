import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("shipped session review flow", () => {
  const app = readFileSync("web/src/App.tsx", "utf8");

  test("recent shipped shortcuts open inside the live workspace without resuming", () => {
    expect(app).toContain(
      "onOpenRecentShipped={openShippedSession}",
    );
    expect(app).toContain("shippedReview={shippedReview}");
    expect(app).toContain('setTab("live")');
    expect(app).not.toContain("function ShipTranscriptSheet(");
    expect(app).not.toContain('toast.message("Resuming shipped session…")');
  });

  test("desktop and mobile use the normal session surfaces", () => {
    expect(app).toContain(
      "shippedReview?.sessionId === sheet.sid ? shippedReview : null",
    );
    expect(app).toContain(
      "return { sid: sourceSid, session: shippedReview };",
    );
  });

  test("mobile live view shows the shared recently shipped list", () => {
    const liveView = app.slice(
      app.indexOf("function LiveView("),
      app.indexOf("function RailStage("),
    );

    expect(liveView).toContain("useRecentShippedSessions(");
    expect(liveView).toContain('<section data-recent-shipped="true">');
    expect(liveView).toContain('label="Recently shipped"');
    expect(liveView).toContain("onOpen={onOpenRecentShipped}");
    expect(liveView).toContain("mobile");
  });

  test("the first new message is included in the resume request", () => {
    expect(app).toContain('await api<{ sessionId?: string }>("/api/sessions/resume"');
    expect(app).toContain("sessionId: sid,\n            prompt: outgoingText,");
    expect(app).toContain("Sending resumes this session.");
  });
});
