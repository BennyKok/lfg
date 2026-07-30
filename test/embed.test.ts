import { describe, expect, test } from "bun:test";
import { embedSearchFlag, isEmbedded, isFramed } from "../web/src/lib/embed.ts";
import {
  readLocationSessionId,
  shouldNavigateToTab,
  shouldPrioritizeSession,
  validateAppSearch,
} from "../web/src/lib/app-search.ts";

describe("embed detection", () => {
  test("accepts embed=1 / true / boolean from search", () => {
    expect(embedSearchFlag({ embed: true })).toBe(true);
    expect(embedSearchFlag({ embed: 1 })).toBe(true);
    expect(embedSearchFlag({ embed: "1" })).toBe(true);
    expect(embedSearchFlag({ embed: "true" })).toBe(true);
    expect(embedSearchFlag({ embed: false })).toBe(false);
    expect(embedSearchFlag({ embed: "0" })).toBe(false);
    expect(embedSearchFlag({})).toBe(false);
    expect(embedSearchFlag(null)).toBe(false);
  });

  test("isEmbedded honors the search flag without needing a frame", () => {
    expect(isEmbedded({ embed: true })).toBe(true);
    expect(isEmbedded({ embed: "1" })).toBe(true);
  });

  test("isFramed is false at the top level (node / jsdom top window)", () => {
    // In unit tests we are not inside an iframe.
    expect(isFramed()).toBe(false);
  });
});

describe("session prioritization + search validation", () => {
  test("validateAppSearch keeps session and embed contracts", () => {
    expect(validateAppSearch({ session: "abc", embed: "1" })).toEqual({
      session: "abc",
      embed: true,
    });
    expect(validateAppSearch({ session: "", embed: "0" })).toEqual({});
    expect(validateAppSearch({ foo: 1 })).toEqual({});
  });

  test("shouldPrioritizeSession is true only with a real session id", () => {
    expect(shouldPrioritizeSession({ session: "s1" })).toBe(true);
    expect(shouldPrioritizeSession({ session: "s1", embed: true })).toBe(true);
    expect(shouldPrioritizeSession({ embed: true })).toBe(false);
    expect(shouldPrioritizeSession({})).toBe(false);
    expect(shouldPrioritizeSession(null)).toBe(false);
  });

  test("same-tab state updates do not navigate and discard deep-link search", () => {
    expect(shouldNavigateToTab("live", "live")).toBe(false);
    expect(shouldNavigateToTab("settings", "settings")).toBe(false);
    expect(shouldNavigateToTab("settings", "live")).toBe(true);
  });

  test("session deep links are available before router search hydration", () => {
    expect(readLocationSessionId("?session=abc&embed=1")).toBe("abc");
    expect(readLocationSessionId("?embed=1")).toBeNull();
    expect(readLocationSessionId("?session=")).toBeNull();
  });
});

describe("host bottom inset contract", () => {
  test("CSS defines a tight embed host inset for the compact omg pill", () => {
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;
    expect(css).toContain('html[data-lfg-embed="true"]');
    expect(css).toMatch(/--lfg-host-bottom-inset:\s*2\.75rem/);
  });

  test("global --lfg-safe-bottom is device-only standalone, host-only in embed", () => {
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;
    // Standalone default: original device home-indicator.
    expect(css).toMatch(/--lfg-device-safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/);
    expect(css).toMatch(/--lfg-safe-bottom:\s*var\(--lfg-device-safe-bottom\)/);
    // Embed: cancel device pad + host pill only (host already owns the
    // home-indicator zone; stacking it double-pads iOS PWAs).
    const embedBlock = css.slice(css.indexOf('html[data-lfg-embed="true"]'));
    expect(embedBlock).toMatch(/--lfg-device-safe-bottom:\s*0px/);
    expect(embedBlock).toMatch(/--lfg-safe-bottom:\s*var\(--lfg-host-bottom-inset\)/);
    // Clearance tokens derive from the global safe bottom.
    expect(css).toMatch(/--lfg-composer-clear:\s*calc\(10\.5rem\s*\+\s*var\(--lfg-safe-bottom\)\)/);
    expect(css).toMatch(/--lfg-orb-bottom:\s*calc\(1\.5rem\s*\+\s*var\(--lfg-safe-bottom\)\)/);
  });

  test("session chat composer pads with global safe bottom (portal is full-bleed)", () => {
    const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;
    // The session sheet portals to document.body, so shell host-pad cannot
    // protect the composer — the form itself must use --lfg-safe-bottom.
    expect(app).toContain("pb-[calc(0.5rem+var(--lfg-safe-bottom))]");
    // No residual session-body pad that only knew about the device safe-area.
    expect(app).not.toMatch(
      /paddingBottom:\s*["']env\(safe-area-inset-bottom(?:,\s*0px)?\)["']/,
    );
  });

  test("inline home uses device pad (standalone) and cancels under embed", () => {
    const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;
    // Standalone: original home-indicator via --lfg-device-safe-bottom.
    // Embed: that token is cancelled to 0; shell host-inset clears the pill.
    expect(app).toContain("pb-[max(var(--lfg-device-safe-bottom),0.5rem)]");
    expect(app).toContain('embedded && "pb-[var(--lfg-host-bottom-inset)]"');
  });

  test("host can reserve top-right space in the embedded mobile header", () => {
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;
    const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;
    // Default 0 so standalone LFG — and any host that floats nothing in that
    // corner — reserves nothing. The value is host-driven (omg sets it on its
    // surface wrapper), unlike the hardcoded bottom inset.
    expect(css).toMatch(/--lfg-host-top-inset:\s*0px/);
    // The embedded mobile header's right island slides left by the inset, so a
    // host island in that corner never lands on the project picker.
    expect(app).toContain("pr-[calc(0.75rem+var(--lfg-host-top-inset))]");
    // Left stays a plain gutter — px-3 would re-symmetrise and undo the above.
    expect(app).not.toMatch(
      /<header className="z-40 flex shrink-0 items-center justify-between gap-2 px-3/,
    );
  });

  test("desktop embed zeroes host-bottom-inset (omg nav is top-middle)", () => {
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;
    // Match omg useIsDesktop (lg = 1024). Mobile keeps the 2.75rem bottom pill.
    expect(css).toMatch(
      /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*?html\[data-lfg-embed="true"\]\s*\{[\s\S]*?--lfg-host-bottom-inset:\s*0px/,
    );
  });
});

describe("mobile overlay scroll contract", () => {
  test("hosted surfaces keep LFG page navigation", () => {
    const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;

    expect(app).toContain("embedded && isMobile");
    expect(app).toContain('tab === "shipped"');
    expect(app).toContain('"__artifacts"');
    expect(app).toContain("projects={projectOptions}");
    expect(app).toContain("onChange={changeProjectFilter}");
    expect(app).toContain("onOpenShipped={openShipped}");
    expect(app).toContain("onOpenRecentShipped={openShippedSession}");
    expect(app).not.toContain(
      "onOpenShipped={embedded ? undefined : openShipped}",
    );
  });

  test("every mobile page scrolls behind the shared top chrome", () => {
    const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;

    expect(app).toContain(
      '"absolute inset-x-0 bottom-[var(--lfg-host-bottom-inset)] top-0 px-2 pt-[var(--lfg-mobile-header-height)]',
    );
    expect(app).toContain('isMobile && "mobile-scroll-header-fade"');
    expect(css).toMatch(
      /--lfg-mobile-header-height:\s*calc\(3\.5rem\s*\+\s*env\(safe-area-inset-top,\s*0px\)\)/,
    );
    expect(css).toMatch(/--lfg-mobile-header-fade-height:\s*1\.25rem/);
    expect(css).toMatch(/opacity:\s*var\(--lfg-mobile-header-fade-opacity,\s*0\)/);
    expect(css).toMatch(
      /\.mobile-scroll-header-fade\s*\{[^}]*isolation:\s*isolate[^}]*\}/,
    );
    expect(css).not.toMatch(
      /\.mobile-scroll-header-fade\s*\{[^}]*backdrop-filter/,
    );
    expect(css).toMatch(
      /\.mobile-scroll-header-fade::before\s*\{[^}]*backdrop-filter:\s*blur\(10px\)/,
    );
    expect(app).toContain("Math.max(0, main.scrollTop) / 24");
  });

  test("composer pages reserve chrome while the fade overlays content", () => {
    const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;

    expect(app).toContain('tab === "live" || tab === "shipped" || tab === "artifacts"');
    expect(app).toContain(
      "pb-[var(--lfg-inline-composer-height,var(--lfg-composer-clear))]",
    );
    expect(app).not.toContain(
      "pb-[calc(var(--lfg-inline-composer-height,var(--lfg-composer-clear))+var(--lfg-mobile-composer-fade-height))]",
    );
    expect(app).toContain(
      "mobile-scroll-composer-fade pointer-events-auto relative z-[55] mt-auto",
    );
    expect(app).not.toContain(
      "overflow-x-clip bg-background/95 pt-4 shadow-[0_-8px_24px_rgba(0,0,0,0.12)]",
    );
    expect(css).toMatch(
      /--lfg-mobile-composer-fade-height:\s*var\(--lfg-mobile-header-fade-height\)/,
    );
    expect(css).toMatch(
      /opacity:\s*var\(--lfg-mobile-composer-fade-opacity,\s*0\)/,
    );
    expect(app).toContain(
      "main.scrollHeight - main.clientHeight - main.scrollTop",
    );
    expect(app).toContain("Math.min(1, remaining / 24)");
  });
});
