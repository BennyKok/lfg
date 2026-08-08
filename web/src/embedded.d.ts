import type { OmgTransport } from "@omg-dev/client";
import type { JSX } from "react";

export { createGrantTransport } from "@omg-dev/client";
export type {
  CreateGrantTransportOptions,
  OmgGrant,
  OmgSocket,
  OmgTransport,
} from "@omg-dev/client";

/**
 * Central sink for client errors raised inside the surface, in addition to the
 * report that goes through the transport into the user's own lfg instance.
 * Hosted surfaces should set this: when the workspace behind the transport is
 * paused or unreachable — the usual state when the surface itself crashed — it
 * is the only copy of the report that survives.
 */
export interface OmgErrorSink {
  /** Absolute URL that accepts a POSTed JSON error report. */
  url: string;
  /** Short label for which host surface this is, e.g. "omg-dashboard". */
  surface?: string;
  /** Version of the embedded lfg app, so a report can be pinned to a build. */
  appVersion?: string;
}

/** Presentation-only identity supplied by an embedding host. */
export interface EmbeddedViewer {
  id: string;
  name: string;
  avatar?: string;
}

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
   * Personalizes hosted welcome/status copy without changing LFG roster,
   * session ownership, filtering, or authorization semantics.
   */
  viewer?: EmbeddedViewer;
  errorSink?: OmgErrorSink;
}

export declare function OmgAppSurface(
  props: OmgAppSurfaceProps,
): JSX.Element;

/**
 * Machine-owned settings pages a host can mount on their own, underneath its
 * own account and plan UI, instead of reimplementing them.
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
   * different screens and none of them are linkable. A host that routes these
   * pages passes this and reflects the page back through `page`. Pages the
   * host doesn't route are reported too — ignore the ones you don't handle;
   * the surface navigates internally either way.
   */
  onNavigate?: (page: OmgSettingsPage) => void;
  className?: string;
  errorSink?: OmgErrorSink;
}

export declare function OmgSettingsSurface(
  props: OmgSettingsSurfaceProps,
): JSX.Element;
