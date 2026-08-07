import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

/**
 * A host-mounted (bare) page lives inside the HOST's scroll container.
 *
 * The standalone shell is `h-dvh overflow-hidden` and scrolls internally. Reuse
 * that for a bare mount and every page taller than one screen is clipped at
 * 100dvh with the remainder unreachable — the host scroller has already ended,
 * and our own overflow is hidden. That is what happened to omg's mounted
 * Storage page once it grew the performance / resource-pressure sections.
 */
describe("bare surface shell", () => {
  const bareShell = app.match(/const BARE_SHELL_CLASS = "([^"]*)"/)?.[1];

  test("bare mount has intrinsic height and does not clip", () => {
    expect(bareShell).toBeDefined();
    expect(bareShell).not.toContain("h-dvh");
    expect(bareShell).not.toContain("h-full");
    expect(bareShell).not.toContain("overflow-hidden");
    // Not a flex column either: the page is the only flow child, and as a flex
    // item its `min-h-0` is permission to shrink below its own content.
    expect(bareShell).not.toContain("flex");
  });

  test("the shell selects it on bare", () => {
    expect(app).toContain("bare ? BARE_SHELL_CLASS : APP_SHELL_CLASS");
  });

  test("the standalone shell still owns the viewport", () => {
    const appShell = app.match(/const APP_SHELL_CLASS = "([^"]*)"/)?.[1];
    expect(appShell).toContain("h-dvh");
    expect(appShell).toContain("overflow-hidden");
  });

  test("the visual-viewport pin never sizes a bare mount", () => {
    // Same clamp as the shell class, written in JS: pinning the root to
    // visualViewport.height caps a host-mounted page at one screen.
    expect(app).toContain("if (el && !bare) {");
  });

  test("the host bottom inset is composer chrome, not bare-page padding", () => {
    expect(app).toContain('embedded && !bare && "pb-[var(--lfg-host-bottom-inset)]"');
  });
});
