import { describe, expect, test } from "bun:test";
import { pathnameToTab, tabToPath } from "../web/src/lib/app-search";

describe("Notification Center route", () => {
  test("uses notifications as the canonical page", () => {
    expect(pathnameToTab("/notifications")).toBe("notifications");
    expect(tabToPath("notifications")).toBe("/notifications");
  });

  test("keeps old shipped links compatible", () => {
    expect(pathnameToTab("/shipped")).toBe("notifications");
    expect(tabToPath("shipped")).toBe("/notifications");
  });
});
