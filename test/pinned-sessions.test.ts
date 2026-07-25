import { describe, expect, test } from "bun:test";
import { retainLivePinnedSessions } from "../web/src/lib/pinned-sessions.ts";

describe("retainLivePinnedSessions", () => {
  test("removes a deleted session from browser-local pins", () => {
    expect(
      retainLivePinnedSessions(
        ["still-live", "deleted", "also-live"],
        ["still-live", "also-live"],
      ),
    ).toEqual(["still-live", "also-live"]);
  });

  test("keeps pins that are live outside the current frontend filter", () => {
    expect(
      retainLivePinnedSessions(
        ["visible-project", "other-project"],
        ["visible-project", "other-project"],
      ),
    ).toEqual(["visible-project", "other-project"]);
  });
});
