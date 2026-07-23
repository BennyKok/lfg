import { describe, expect, test } from "bun:test";
import {
  BOTTOM_SYSTEM_GESTURE_GUARD_PX,
  startsInBottomSystemGestureZone,
} from "../web/src/lib/touch-gestures";

describe("startsInBottomSystemGestureZone", () => {
  test("protects a swipe beginning at the iOS home indicator", () => {
    expect(startsInBottomSystemGestureZone(830, 844)).toBe(true);
  });

  test("allows an intentional upward composer swipe above the edge guard", () => {
    expect(
      startsInBottomSystemGestureZone(
        844 - BOTTOM_SYSTEM_GESTURE_GUARD_PX - 1,
        844,
      ),
    ).toBe(false);
  });

  test("does not reject gestures when the viewport height is unavailable", () => {
    expect(startsInBottomSystemGestureZone(10, 0)).toBe(false);
  });
});
