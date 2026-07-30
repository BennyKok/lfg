// Guards the Notifications/Artifacts navigation contract.
//
// WHY A SOURCE-LEVEL TEST. These pages disappeared from the desktop rail for
// several releases and nothing failed: they were reachable only through the
// project picker's "Pages" optgroup, and when the rail switched to the repo-only
// drawer picker that group silently vanished. Typechecking cannot see a lost
// entry point, and this repo's `tsc` (TypeScript 7 native preview) does not even
// flag an undefined identifier — so the regression shipped invisibly.
//
// These assertions are about *reachability*, which is the property that broke.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

describe("page navigation reachability", () => {
  test("the overflow menu offers every built-in page", () => {
    const menu = app.slice(app.indexOf("function PagesMenu("));
    const body = menu.slice(0, menu.indexOf("\nfunction "));
    for (const page of ["live", "notifications", "artifacts", "settings"]) {
      expect(body, `PagesMenu is missing ${page}`).toContain(`value="${page}"`);
    }
  });

  test("settings can be hidden when the host owns it", () => {
    const menu = app.slice(app.indexOf("function PagesMenu("));
    const body = menu.slice(0, menu.indexOf("\nfunction "));
    expect(body).toContain("showSettings");
    expect(body).toContain('{showSettings ? (');
    expect(app).toContain("showSettings={!embedded}");
  });

  test("the overflow menu lists runtime extension tabs", () => {
    // Extension tabs render only inside the Settings page, which embed mode
    // hides — so without this they are unreachable inside omg entirely.
    const menu = app.slice(app.indexOf("function PagesMenu("));
    const body = menu.slice(0, menu.indexOf("\nfunction "));
    expect(body).toContain("extraTabs.map");
  });

  test("both rail layouts render the menu", () => {
    // Collapsed and expanded. The collapsed strip previously had a lone Shipped
    // megaphone and no Artifacts entry at all.
    // Count standalone renders only — `pagesMenu={pagesMenu}` (the prop forward)
    // contains the same substring and must not be counted as a render site.
    const renders = app
      .split("\n")
      .filter((line) => line.trim() === "{pagesMenu}").length;
    expect(renders, "expected the rail to render pagesMenu twice").toBe(2);
  });

  test("the shell builds the menu and passes it down", () => {
    expect(app).toMatch(/pagesMenu=\{\s*<PagesMenu/);
    expect(app).toContain("<PagesMenu");
    expect(app).toContain("onOpenTab={setTab}");
    expect(app).toContain("extraTabs={extNavTabs}");
    expect(app).toContain("showSettings={!embedded}");
  });

  test("the header is not suppressed wholesale when embedded", () => {
    // The regression that left Notifications/Artifacts with no chrome at all: the
    // header was `null` for every embedded page, so there was no way back to
    // Live except browser history. Only the live-desktop case may skip it,
    // because there the rail is the chrome.
    expect(app).not.toContain("embedded || liveDesktopWorkspace ? null");
    expect(app).toContain(") : liveDesktopWorkspace ? null : (");
  });

  test("host-owned chrome stays out of the embedded header", () => {
    // Un-suppressing the header must not leak omg's own concerns back in.
    for (const guarded of ["<AskNavButton", "<UserFilterMenu"]) {
      const at = app.indexOf(guarded, app.indexOf(") : liveDesktopWorkspace ? null : ("));
      expect(at, `${guarded} not found in the header`).toBeGreaterThan(0);
      // Each is preceded by an `embedded ? null :` guard within a few lines.
      const before = app.slice(Math.max(0, at - 200), at);
      expect(before, `${guarded} is not gated on embedded`).toContain("embedded ? null :");
    }
  });
});
