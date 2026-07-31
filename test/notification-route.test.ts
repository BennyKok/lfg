import { describe, expect, test } from "bun:test";
import { pathnameToTab, TAB_VALUES, tabToPath } from "../web/src/lib/app-search";

describe("Notification Center route", () => {
  test("uses notifications as the canonical page", () => {
    expect(pathnameToTab("/notifications")).toBe("notifications");
    expect(tabToPath("notifications")).toBe("/notifications");
  });

  test("keeps old shipped links compatible", () => {
    expect(pathnameToTab("/shipped")).toBe("notifications");
    expect(tabToPath("shipped")).toBe("/notifications");
  });

  // Agent questions used to own a page at /ask. They are a form of
  // notification, so they moved into the Notification Center and the page went
  // away — but pushed links, bookmarks and the service worker's deep links can
  // still point at /ask.
  test("folds the retired ask page into notifications", () => {
    expect(pathnameToTab("/ask")).toBe("notifications");
    expect(tabToPath("ask")).toBe("/notifications");
  });

  test("ask is no longer a page of its own", () => {
    expect(TAB_VALUES).not.toContain("ask");
    expect(TAB_VALUES).toContain("notifications");
  });
});
