export type ClientErrorLike = {
  message?: string | null;
  stack?: string;
  componentStack?: string;
};

export type ClientErrorNoiseReason =
  | "empty-or-cross-origin-script"
  | "resize-observer-delivery"
  | "stackless-load-failure"
  | "unattributed-network-failure";

// Browsers surface ResizeObserver's delivery deferral as a window `error`
// event even though no exception escaped and the queued observations are
// delivered on a later frame. These are the two browser-defined messages; keep
// the match exact so a real application error that merely mentions an observer
// is still actionable.
const RESIZE_OBSERVER_DELIVERY =
  /^resizeobserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/i;

/**
 * Classify browser/runtime reports that cannot be fixed in LFG source.
 *
 * This policy is shared by the browser sender and the server ingestion path:
 * the browser avoids needless traffic, while the server remains authoritative
 * for older cached clients and direct API callers.
 */
export function clientErrorNoiseReason(
  error: ClientErrorLike,
): ClientErrorNoiseReason | null {
  const message = (error.message ?? "").trim();
  const lower = message.toLowerCase();

  if (!lower || lower === "script error." || lower === "script error") {
    return "empty-or-cross-origin-script";
  }
  if (RESIZE_OBSERVER_DELIVERY.test(message)) {
    return "resize-observer-delivery";
  }
  if (lower.includes("load failed") && !error.stack) {
    return "stackless-load-failure";
  }
  if (/networkerror|failed to fetch/.test(lower) && !error.componentStack) {
    return "unattributed-network-failure";
  }
  return null;
}

export function isClientErrorNoise(error: ClientErrorLike): boolean {
  return clientErrorNoiseReason(error) !== null;
}
