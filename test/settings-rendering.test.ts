import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

function componentBody(name: string): string {
  const start = app.indexOf(`function ${name}(`);
  expect(start, `${name} was not found`).toBeGreaterThanOrEqual(0);
  const next = app.indexOf("\nfunction ", start + 1);
  return app.slice(start, next < 0 ? undefined : next);
}

describe("settings rendering", () => {
  test("agent pause state has a visible switch affordance", () => {
    const section = componentBody("AgentConcurrencySettingsSection");

    expect(section).toContain('aria-label="Pause new agents"');
    expect(section).toContain("checked={settings.agentsPaused}");
    expect(section).toContain("onCheckedChange={(next) => void togglePause(next)}");
    expect(section).not.toContain("togglePause(!settings.agentsPaused)");
  });

  test("mobile secondary chrome leaves clearance above page content", () => {
    expect(app).toContain(
      'className="z-40 flex shrink-0 items-center pb-3 pl-3 pr-[calc(0.75rem+var(--lfg-host-top-inset))]',
    );
    expect(app).toContain(
      'className="relative z-40 flex shrink-0 items-center justify-between gap-2 px-2 pb-3 pt-[calc(0.5rem+env(safe-area-inset-top))] md:px-3 md:pb-1"',
    );
  });
});
