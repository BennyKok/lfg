// Embed-only first-run gate.
//
// A framed LFG hides onboarding and settings (the host owns account UX), so a
// fresh box had no surface at all for connecting a coding agent. This card is
// that surface and nothing more: it renders the two browser-loginable
// providers and hands the click straight back to App's existing
// `loginCodingAgent` / `setupCodingAgent`, which drive the same
// /api/coding-agents endpoints and the same <CodingAgentAuthDialog> the
// Settings page uses. No credentials, no second auth path, no progress bar —
// the card disappears the moment the agent roster reports something
// configured.

import { Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import type { ConnectOption } from "../lib/embedded-connect";

export function EmbeddedConnectGate({
  options,
  pendingKind,
  onConnect,
  onInstall,
  onSkip,
}: {
  options: ConnectOption[];
  /** Kind with an in-flight connect/install click, if any. */
  pendingKind?: string | null;
  onConnect: (kind: string) => void;
  onInstall: (kind: string) => void;
  onSkip: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center overflow-y-auto overscroll-none bg-background px-6 text-foreground"
      style={{ height: "var(--lfg-app-height, 100dvh)" }}
    >
      <div className="my-auto w-full max-w-sm py-6">
        <div className="mb-4 flex items-center gap-2">
          <img src="/icon.svg" alt="lfg" className="size-7 shrink-0" />
        </div>
        <h1 className="text-xl font-semibold">Connect a coding agent</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          Sign in once and this Computer can start sessions. It opens the
          provider&rsquo;s sign-in page — nothing is stored here.
        </p>
        <div className="flex flex-col gap-2">
          {options.map((option) => {
            const pending = pendingKind === option.kind;
            const needsInstall = !option.installed;
            const blocked = needsInstall && !option.canAutoSetup;
            return (
              <div
                key={option.kind}
                className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {blocked
                      ? "CLI not installed on this Computer"
                      : needsInstall
                        ? "Install first, then sign in"
                        : `Sign in with ${option.provider === "claude" ? "Claude" : "ChatGPT"}`}
                  </span>
                </span>
                <Button
                  variant={option.provider === "claude" ? "brand" : "outline"}
                  size="sm"
                  disabled={pending || blocked}
                  onClick={() =>
                    needsInstall ? onInstall(option.kind) : onConnect(option.kind)
                  }
                >
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : needsInstall ? (
                    "Install"
                  ) : (
                    "Connect"
                  )}
                </Button>
              </div>
            );
          })}
        </div>
        {/* Escape hatch: an expired login must never lock someone out of
            sessions that are already running. Deliberately not persisted —
            the gate returns on the next load while nothing is configured. */}
        <button
          type="button"
          onClick={onSkip}
          className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
