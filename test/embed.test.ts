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
});
