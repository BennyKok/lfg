import { describe, expect, test } from "bun:test";

import { normalizeBasePath } from "./config.ts";

describe("normalizeBasePath", () => {
  test("defaults empty values to root", () => {
    expect(normalizeBasePath(undefined)).toBe("/");
    expect(normalizeBasePath("")).toBe("/");
    expect(normalizeBasePath("   ")).toBe("/");
    expect(normalizeBasePath("/")).toBe("/");
  });

  test("normalizes non-root paths with leading and trailing slashes", () => {
    expect(normalizeBasePath("lfg")).toBe("/lfg/");
    expect(normalizeBasePath("/lfg")).toBe("/lfg/");
    expect(normalizeBasePath("/lfg/")).toBe("/lfg/");
    expect(normalizeBasePath("//lfg//admin")).toBe("/lfg/admin/");
  });

  test("rejects values that are not plain path prefixes", () => {
    expect(() => normalizeBasePath("/lfg?x=1")).toThrow("query string or hash");
    expect(() => normalizeBasePath("/lfg#top")).toThrow("query string or hash");
    expect(() => normalizeBasePath("/../lfg")).toThrow("path segments");
    expect(() => normalizeBasePath("/./lfg")).toThrow("path segments");
  });
});
