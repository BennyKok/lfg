import { describe, expect, test } from "bun:test";
import { embedSearchFlag, isEmbedded, isFramed } from "../web/src/lib/embed.ts";
import { shouldPrioritizeSession, validateAppSearch } from "../web/src/lib/app-search.ts";

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
});

describe("host bottom inset contract", () => {
  test("CSS defines a tight embed host inset for the compact omg pill", () => {
    const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;
    expect(css).toContain('html[data-lfg-embed="true"]');
    expect(css).toMatch(/--lfg-host-bottom-inset:\s*2\.75rem/);
  });
});
