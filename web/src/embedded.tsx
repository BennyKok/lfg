import { useEffect, useLayoutEffect, useState } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  type AnyRouter,
} from "@tanstack/react-router";
import type { LfgTransport } from "@lfg-dev/client";

import "./index.css";
import { RootErrorBoundary } from "./App";
import { AppDialogProvider } from "./components/ui/app-dialog";
import { configureLfgTransport } from "./lib/lfg-client";
import { createLfgRouter } from "./router";

export interface LfgAppSurfaceProps {
  transport: LfgTransport;
  assetBaseUrl?: string;
  sessionId?: string | null;
  className?: string;
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
 */
export function LfgAppSurface({
  transport,
  assetBaseUrl,
  sessionId,
  className,
}: LfgAppSurfaceProps) {
  const [releaseTransport] = useState(() =>
    configureLfgTransport(transport, { assetBaseUrl }),
  );
  const [router] = useState<AnyRouter>(() =>
    createLfgRouter(
      createMemoryHistory({ initialEntries: [initialPath(sessionId)] }),
    ),
  );

  useEffect(() => releaseTransport, [releaseTransport]);
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
