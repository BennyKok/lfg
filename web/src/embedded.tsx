import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  type AnyRouter,
} from "@tanstack/react-router";
import type { OmgTransport } from "@omg-dev/client";

import "./index.css";
import { RootErrorBoundary } from "./App";
import { AppDialogProvider } from "./components/ui/app-dialog";
import { configureOmgTransport, type OmgErrorSink } from "./lib/omg-client";
import { BareSurfaceProvider } from "./lib/bare-surface";
import {
  EmbeddedHostOptionsProvider,
  type EmbeddedViewer,
} from "./lib/embedded-host-options";
import { claimSurfaceAttribute } from "./lib/surface-attribute";
import { createOmgRouter } from "./router";

export type { EmbeddedViewer } from "./lib/embedded-host-options";

export { createGrantTransport } from "@omg-dev/client";
export type {
  CreateGrantTransportOptions,
  OmgGrant,
  OmgSocket,
  OmgTransport,
} from "@omg-dev/client";

export interface OmgAppSurfaceProps {
  transport: OmgTransport;
  assetBaseUrl?: string;
  sessionId?: string | null;
  className?: string;
  /**
   * Show LFG's embedded first-run provider connection gate. Defaults to true.
   * Managed hosts that preselect a credential-free agent can disable this and
   * keep provider connections as an optional Settings action.
   */
  connectionOnboarding?: boolean;
  /**
   * Presentation-only identity for the person viewing a hosted surface.
   * This personalizes welcome/status copy but never participates in LFG's
   * roster, session ownership, filtering, or authorization.
   */
  viewer?: EmbeddedViewer;
  /**
   * Central sink for client errors, in addition to the report that goes through
   * the transport into the user's own lfg instance. A hosted surface should set
   * this: when the workspace behind the transport is paused or unreachable — the
   * usual state when the surface itself crashed — it is the only copy that
   * survives. Omit it and reporting stays purely transport-local.
   */
  errorSink?: OmgErrorSink;
}

function initialPath(sessionId?: string | null): string {
  const search = new URLSearchParams({ embed: "true" });
  if (sessionId) search.set("session", sessionId);
  return `/?${search.toString()}`;
}

/**
 * Pages a host can mount on their own, without the surrounding session UI.
 *
 * These are the machine-owned settings: what the box has installed, what it
 * runs on a timer, and what it's using. A host that has its own account and
 * plan UI mounts these underneath it rather than reimplementing them, which
 * is what keeps the two products from drifting into different answers for
 * the same setting.
 */
export type OmgSettingsPage =
  | "settings"
  | "coding-agents"
  | "auto"
  | "storage"
  | "more";

export interface OmgSettingsSurfaceProps {
  transport: OmgTransport;
  assetBaseUrl?: string;
  /**
   * Which page to show. CONTROLLED when the host also passes `onNavigate`:
   * changing this prop navigates the surface, no remount required.
   */
  page?: OmgSettingsPage;
  /**
   * Called when the surface navigates itself — the user tapped "Coding
   * agents", "Storage", "More", or a back link inside a page.
   *
   * Without this the surface's pages are invisible to the host: it runs on a
   * memory history, so a host with its own router shows one URL for five
   * different screens, the device back button leaves the whole surface instead
   * of going up one page, and none of it is linkable. A host that routes these
   * pages itself passes this and reflects the page back through `page`.
   *
   * Pages the host doesn't route are reported too — handle the ones you know
   * and ignore the rest; the surface navigates internally either way, so an
   * unhandled page still works.
   */
  onNavigate?: (page: OmgSettingsPage) => void;
  className?: string;
  errorSink?: OmgErrorSink;
}

const SETTINGS_PAGES: readonly OmgSettingsPage[] = [
  "settings",
  "coding-agents",
  "auto",
  "storage",
  "more",
];

function pathToSettingsPage(pathname: string): OmgSettingsPage | null {
  const seg = pathname.split("/").filter(Boolean)[0];
  const page = (seg ? decodeURIComponent(seg) : "settings") as OmgSettingsPage;
  return SETTINGS_PAGES.includes(page) ? page : null;
}

/**
 * A single LFG settings page mounted inside another React product.
 *
 * Same app, same endpoints, same components as the standalone settings page —
 * only the entry route differs. The host supplies the transport, so which
 * machine these settings belong to is entirely the host's decision.
 */
export function OmgSettingsSurface({
  transport,
  assetBaseUrl,
  page = "settings",
  onNavigate,
  className,
  errorSink,
}: OmgSettingsSurfaceProps) {
  // The host owns the header, the back affordance and the account, so this
  // surface renders sections only — declared to the tree below, not to a
  // module global that a coexisting full-app surface would also read.
  configureOmgTransport(transport, { assetBaseUrl, errorSink });
  const [router] = useState<AnyRouter>(() =>
    createOmgRouter(
      createMemoryHistory({ initialEntries: [`/${page}?embed=true`] }),
    ),
  );

  // Ref, not a dep: a host that passes an inline arrow would otherwise
  // re-subscribe on every render.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // Report internal navigation outward. `subscribe` fires after the location
  // has changed, so the host is told where the surface actually IS — echoing
  // that back through `page` is a no-op below rather than a second navigation.
  useEffect(() => {
    return router.subscribe("onResolved", () => {
      const next = pathToSettingsPage(router.state.location.pathname);
      if (next) onNavigateRef.current?.(next);
    });
  }, [router]);

  // Host-driven navigation: the host's URL is the source of truth once it
  // routes these pages, so a browser back/forward or a deep link moves the
  // surface. Guarded on the current location because the common case is the
  // host echoing back the page we just reported.
  useEffect(() => {
    if (pathToSettingsPage(router.state.location.pathname) === page) return;
    void router.navigate({ to: `/${page}`, search: { embed: true }, replace: true });
  }, [router, page]);

  // Ref-counted: a host can have two surfaces alive at once, and the first one
  // to unmount must not strip the stylesheet's anchor off the other.
  useLayoutEffect(() => claimSurfaceAttribute(), []);

  return (
    <div className={className} data-lfg-app-surface="" data-lfg-settings-surface={page}>
      <BareSurfaceProvider bare>
        <RootErrorBoundary>
          <AppDialogProvider>
            <RouterProvider router={router} />
          </AppDialogProvider>
        </RootErrorBoundary>
      </BareSurfaceProvider>
    </div>
  );
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
export function OmgAppSurface({
  transport,
  assetBaseUrl,
  sessionId,
  className,
  connectionOnboarding = true,
  viewer,
  errorSink,
}: OmgAppSurfaceProps) {
  // A full LFG app is the sole owner of its runtime transport. Install it
  // synchronously so child effects cannot race the host boundary; there is no
  // cleanup that can revert another Strict Mode mount back to same-origin.
  configureOmgTransport(transport, { assetBaseUrl, errorSink });
  const [router] = useState<AnyRouter>(() =>
    createOmgRouter(
      createMemoryHistory({ initialEntries: [initialPath(sessionId)] }),
    ),
  );

  // Ref-counted: a host can have two surfaces alive at once, and the first one
  // to unmount must not strip the stylesheet's anchor off the other.
  useLayoutEffect(() => claimSurfaceAttribute(), []);

  return (
    <div className={className} data-lfg-app-surface="">
      <EmbeddedHostOptionsProvider value={{ connectionOnboarding, viewer }}>
        <BareSurfaceProvider bare={false}>
          <RootErrorBoundary>
            <AppDialogProvider>
              <RouterProvider router={router} />
            </AppDialogProvider>
          </RootErrorBoundary>
        </BareSurfaceProvider>
      </EmbeddedHostOptionsProvider>
    </div>
  );
}
