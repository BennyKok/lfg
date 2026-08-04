import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

describe("mobile secondary page hierarchy", () => {
  test("keeps notifications and artifacts out of project navigation", () => {
    const projectMenu = app.slice(
      app.indexOf("function ProjectFilterMenu("),
      app.indexOf("function WhoAreYou("),
    );
    expect(projectMenu).not.toContain("__notifications");
    expect(projectMenu).not.toContain("__artifacts");
    expect(projectMenu).not.toContain('<optgroup label="Pages">');
  });

  test("does not install a page swipe gesture", () => {
    const shellNavigation = app.slice(
      app.indexOf("const changeProjectFilter"),
      app.indexOf("// Tab / Shift+Tab cycles"),
    );
    expect(shellNavigation).not.toContain("pageSwipeCtx");
    expect(shellNavigation).not.toContain("swipePageAnim");
    expect(shellNavigation).not.toContain("addEventListener(\"touchmove\"");
  });

  test("shows the composer on mobile Live only", () => {
    expect(app).toMatch(
      /const mobileComposerVisible\s*=\s*isMobile[\s\S]*?!terminalSid\s*&&\s*tab === "live";/,
    );
  });

  test("secondary mobile pages provide an explicit return to Live", () => {
    expect(app.match(/aria-label="Back to Live"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(app).toContain('isMobile && (tab === "notifications" || tab === "artifacts")');
  });
});
