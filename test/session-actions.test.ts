import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");
const doubleConfirm = readFileSync(
  "web/src/components/ui/double-confirm-action.tsx",
  "utf8",
);

function section(start: string, end: string): string {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return app.slice(from, to);
}

describe("session lifecycle actions", () => {
  test("only offers Stop while the session is busy", () => {
    const dropdown = section(
      "function SessionActionsMenu(",
      "function RailSessionContextMenu(",
    );
    const context = section(
      "function RailSessionContextMenu(",
      "function SessionTitleSheet(",
    );

    for (const menu of [dropdown, context]) {
      expect(menu).toContain("busy: boolean;");
      expect(menu).toMatch(/\{busy \? \([\s\S]*?>\s*Stop\s*</);
      expect(menu).toContain('label="Archive session"');
    }
  });

  test("archives with the shared inline double-confirm instead of a dialog", () => {
    const actions = section(
      "function useSessionActions({",
      "function SessionActionsMenu(",
    );

    expect(actions).not.toContain("appDialog.confirm");
    expect(app.match(/<DoubleConfirmAction/g)?.length).toBe(2);
    expect(app.match(/confirmLabel="Confirm archive"/g)?.length).toBe(2);
    expect(doubleConfirm).toContain("closeOnClick: armed && !pending");
    expect(doubleConfirm).toContain("setTimeout(() => setArmed(false), timeoutMs)");
    expect(doubleConfirm).toContain("slide-in-from-bottom-1");
  });
});
