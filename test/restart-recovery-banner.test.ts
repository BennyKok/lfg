import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

function pausedBanner(): string {
  const start = app.indexOf("function PausedBanner(");
  const end = app.indexOf("function CodingAgentAuthPanel(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
}

describe("restart recovery banner", () => {
  test("offers a one-tap Continue action", () => {
    const banner = pausedBanner();

    expect(banner).toContain('reason === "restart_recovered"');
    expect(banner).toContain('working ? "Continuing…" : "Continue"');
    expect(app).toContain('onContinue={() => sendMessage(undefined, "Continue.")}');
  });

  test("does not use an emoji in the banner title", () => {
    const banner = pausedBanner();

    expect(banner).toContain('<div className="font-semibold text-warning">{title}</div>');
    expect(banner).not.toContain("⏸");
  });

  test("replaces the idle dot with a pause icon for blocked sessions", () => {
    expect(app).toContain('paused={session.status === "blocked"}');
    expect(app).toContain('<Pause className="size-2.5" fill="currentColor" strokeWidth={0} />');
    expect(app).not.toContain("⏸ paused");
  });
});
