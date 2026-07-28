export type VisibilityRecoveryAction = "connect" | "probe" | "wait";

// WebSocket readyState values are stable browser constants:
// CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3.
export function visibilityRecoveryAction(
  readyState: number | null,
  reconnectPending: boolean,
): VisibilityRecoveryAction {
  if (reconnectPending || readyState == null || readyState >= 2) return "connect";
  return readyState === 1 ? "probe" : "wait";
}
