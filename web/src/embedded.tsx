import { useLayoutEffect, useState } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  type AnyRouter,
} from "@tanstack/react-router";
import type { LfgTransport } from "@lfg-dev/client";

import "./index.css";
import { RootErrorBoundary } from "./App";
import { AppDialogProvider } from "./components/ui/app-dialog";
import { configureLfgTransport, type LfgErrorSink } from "./lib/lfg-client";
import { createLfgRouter } from "./router";

export { createGrantTransport } from "@lfg-dev/client";
export type {
  CreateGrantTransportOptions,
  LfgGrant,
  LfgSocket,
  LfgTransport,
} from "@lfg-dev/client";

export interface LfgAppSurfaceProps {
  transport: LfgTransport;
  assetBaseUrl?: string;
  sessionId?: string | null;
  className?: string;
  /**
   * Central sink for client errors, in addition to the report that goes through
   * the transport into the user's own lfg instance. A hosted surface should set
   * this: when the workspace behind the transport is paused or unreachable — the
   * usual state when the surface itself crashed — it is the only copy that
   * survives. Omit it and reporting stays purely transport-local.
   */
  errorSink?: LfgErrorSink;
}

function initialPath(sessionId?: string | null): string {
  const search = new URLSearchParams({ embed: "true" });
  if (sessionId) search.set("session", sessionId);
  return `/?${search.toString()}`;
}

/**
 * The exact LFG web application mounted inside another React product.
 *
 * A memory router keeps LFG's internal page state private to the surface while
 * the injected transport makes the host the sole owner of authentication.
 *
 * Note it does NOT call installErrorReporting(): those are `window` listeners,
 * and in a shared document they would hoover up the HOST product's errors too,
 * filing them as lfg findings and dispatching auto-fix agents against the wrong
 * repository. Embedded reporting is therefore scoped by construction — the
 * router's error component and RootErrorBoundary only ever see throws from
 * inside this tree.
 */
export function LfgAppSurface({
  transport,
  assetBaseUrl,
  sessionId,
  className,
  errorSink,
}: LfgAppSurfaceProps) {
  // A full LFG app is the sole owner of its runtime transport. Install it
  // synchronously so child effects cannot race the host boundary; there is no
  // cleanup that can revert another Strict Mode mount back to same-origin.
  configureLfgTransport(transport, { assetBaseUrl, errorSink });
  const [router] = useState<AnyRouter>(() =>
    createLfgRouter(
      createMemoryHistory({ initialEntries: [initialPath(sessionId)] }),
    ),
  );

  useLayoutEffect(() => {
    document.documentElement.dataset.lfgAppSurface = "";
    return () => {
      delete document.documentElement.dataset.lfgAppSurface;
    };
  }, []);

  return (
    <div className={className} data-lfg-app-surface="">
      <RootErrorBoundary>
        <AppDialogProvider>
          <RouterProvider router={router} />
        </AppDialogProvider>
      </RootErrorBoundary>
    </div>
  );
}
