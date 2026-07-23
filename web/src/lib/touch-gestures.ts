export const BOTTOM_SYSTEM_GESTURE_GUARD_PX = 48;

/**
 * Bottom-edge drags are reserved by iOS and gesture-navigation Android for
 * Home / app switching. WebKit can still deliver the beginning of that touch
 * sequence to the page, so app gestures must decline it explicitly.
 */
export function startsInBottomSystemGestureZone(
  clientY: number,
  viewportHeight: number,
  guardPx = BOTTOM_SYSTEM_GESTURE_GUARD_PX,
): boolean {
  return viewportHeight > 0 && clientY >= viewportHeight - guardPx;
}
