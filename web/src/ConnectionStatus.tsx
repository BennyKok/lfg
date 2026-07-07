import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ConnectionState } from "./useLiveSocket";

const WS_TOAST_ID = "ws-conn";

// User-facing copy only — deliberately no raw WebSocket close codes or attempt
// counts. Those are captured in evlog for debugging; users just need to know
// we're working on it.

// Headless: no persistent pill in the UI. Connectivity blips are surfaced as
// toasts (via the app's existing sonner Toaster) that update in place rather
// than stacking, so a flappy connection doesn't spam the toast stack.
export function ConnectionStatusToasts({
  connection,
  onRetry,
}: {
  connection: ConnectionState;
  onRetry: () => void;
}) {
  const { status, attempt, lastCloseCode } = connection;
  const prevStatusRef = useRef(status);

  useEffect(() => {
    const wasDisconnected = prevStatusRef.current === "reconnecting" || prevStatusRef.current === "offline";
    prevStatusRef.current = status;

    if (status === "reconnecting") {
      toast.loading("Reconnecting…", { id: WS_TOAST_ID });
      return;
    }

    if (status === "offline") {
      toast.error("You're offline — we'll reconnect automatically", {
        id: WS_TOAST_ID,
        duration: Infinity,
        action: { label: "Retry now", onClick: onRetry },
      });
      return;
    }

    if (status === "live" && wasDisconnected) {
      toast.dismiss(WS_TOAST_ID);
      toast.success("Reconnected", { duration: 2000 });
    }
    // "connecting" (initial load) and steady-state "live" stay silent — no nagging.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, attempt, lastCloseCode, onRetry]);

  return null;
}
