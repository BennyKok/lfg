// The screen a user actually sees when a render throws.
//
// Before this existed, an uncaught render error inside the router's
// CatchBoundary fell through to TanStack's built-in error component — a bare
// "Something went wrong! / Hide Error" strip with a red monospace box, pinned
// to the top of an otherwise empty page. It looked like a stack trace had
// escaped into production (because one had), and it offered no way out except
// a manual reload.
//
// Two jobs, in this order of importance:
//   1. Get the user moving again. Retry re-renders the boundary; Reload throws
//      the whole document away. Both are one tap.
//   2. Keep the diagnosis, without shouting it. The message is visible because
//      the person reporting the bug will read it back to us; the stack lives
//      behind a disclosure and a Copy button, not in the user's face.
//
// It is deliberately one component for both shapes: `screen` for a top-level
// crash that owns the viewport, `card` for an isolated view that failed inside
// an otherwise-healthy app. Same words, same affordances, same reporting — a
// second bespoke crash UI would drift out of sync with this one.

import { useEffect, useState } from "react";
import { Check, CircleAlert, Copy, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUILD_ID, isChunkLoadError, reportError } from "@/lib/report-error";
import { cn } from "@/lib/utils";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Unknown error";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) || "Unknown error";
  } catch {
    return String(error);
  }
}

function stackOf(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export type AppCrashProps = {
  error: unknown;
  /** React's component stack, when the catcher had one. */
  componentStack?: string;
  /** Re-render the subtree that threw. Omitted when there is nothing to retry. */
  reset?: () => void;
  /** `screen` owns the viewport; `card` sits inline inside a healthy app. */
  variant?: "screen" | "card";
  /** Extra context for the report — which view/boundary caught it. */
  boundary?: string;
  className?: string;
};

export function AppCrash({
  error,
  componentStack,
  reset,
  variant = "screen",
  boundary,
  className,
}: AppCrashProps) {
  const message = messageOf(error);
  const stack = stackOf(error);
  // A failed code-split chunk is almost never a bug in this build — it's a
  // client running a PREVIOUS build asking for a hash the server dropped. Say
  // "update", not "error", and lead with Reload: that is the actual fix.
  const stale = isChunkLoadError(message);
  const [reported, setReported] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // The router's CatchBoundary swallows the throw before any React error
    // boundary sees it, so this effect is the ONLY reporting hook on the
    // router path. reportError dedups by signature, so overlapping reports
    // from a wrapping boundary collapse into one.
    setReported(
      reportError({
        kind: "react",
        message,
        stack,
        componentStack,
        source: boundary,
      }),
    );
  }, [message, stack, componentStack, boundary]);

  const details = [
    message,
    boundary ? `boundary: ${boundary}` : null,
    BUILD_ID ? `build: ${BUILD_ID}` : null,
    stack ? `\n${stack}` : null,
    componentStack ? `\ncomponent stack:${componentStack}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const copy = () => {
    void navigator.clipboard
      .writeText(details)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard denied — the disclosure below is still selectable */
      });
  };

  // The stale-build case is not a crash report, it's a one-tap prompt. Giving
  // it the error layout — a small left-aligned icon, a small title, a button
  // crowded under both — made an otherwise empty screen read as cramped and
  // half-broken. Centered column, room to breathe, one obvious CTA.
  if (stale) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center bg-background p-6 text-foreground",
          variant === "screen" ? "h-full min-h-dvh" : "rounded-xl border border-border/60 py-12",
          className,
        )}
        role="alert"
      >
        <div className="flex w-full max-w-xs flex-col items-center text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-brand/12 text-brand">
            <RefreshCw className="size-6" aria-hidden />
          </span>
          <h1 className="mt-5 text-lg font-semibold tracking-tight">New version available</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            lfg updated while this tab was open. Reload to pick up the latest build.
          </p>
          <Button
            size="lg"
            variant="brand"
            className="mt-7 w-full"
            onClick={() => window.location.reload()}
          >
            <RefreshCw className="size-4" aria-hidden />
            Reload
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 bg-background p-6 text-foreground",
        variant === "screen" ? "h-full min-h-dvh" : "rounded-xl border border-border/60",
        className,
      )}
      role="alert"
    >
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <CircleAlert className="size-4" aria-hidden />
          </span>
          <span className="text-sm font-semibold">Something broke</span>
        </div>

        <p className="mt-3 max-h-16 overflow-hidden break-words rounded-lg border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {message}
        </p>

        <div className="mt-3 flex items-center gap-2">
          {reset && (
            <Button size="sm" variant="outline" onClick={reset}>
              <RotateCcw className="size-3.5" aria-hidden />
              Retry
            </Button>
          )}
          <Button size="sm" variant="brand" onClick={() => window.location.reload()}>
            <RefreshCw className="size-3.5" aria-hidden />
            Reload
          </Button>
          <Button
            size="icon-sm"
            variant="tint"
            onClick={copy}
            aria-label="Copy error details"
            title="Copy error details"
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
          </Button>
        </div>

        <div className="mt-3 space-y-1.5 text-[11px] text-muted-foreground/80">
          {/* Claim the report only when one was actually dispatched — a
              reassuring lie here is worse than silence, because the user
              stops telling us about a bug nobody received. */}
          {reported && <div>Reported to lfg.</div>}
          {(stack || componentStack) && (
            <details>
              <summary className="cursor-pointer select-none hover:text-foreground">Details</summary>
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
                {details}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
