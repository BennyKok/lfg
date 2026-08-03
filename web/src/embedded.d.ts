import type { LfgTransport } from "@lfg-dev/client";
import type { JSX } from "react";

export { createGrantTransport } from "@lfg-dev/client";
export type {
  CreateGrantTransportOptions,
  LfgGrant,
  LfgSocket,
  LfgTransport,
} from "@lfg-dev/client";

/**
 * Central sink for client errors raised inside the surface, in addition to the
 * report that goes through the transport into the user's own lfg instance.
 * Hosted surfaces should set this: when the workspace behind the transport is
 * paused or unreachable — the usual state when the surface itself crashed — it
 * is the only copy of the report that survives.
 */
export interface LfgErrorSink {
  /** Absolute URL that accepts a POSTed JSON error report. */
  url: string;
  /** Short label for which host surface this is, e.g. "omg-dashboard". */
  surface?: string;
  /** Version of the embedded lfg app, so a report can be pinned to a build. */
  appVersion?: string;
}

export interface LfgAppSurfaceProps {
  transport: LfgTransport;
  assetBaseUrl?: string;
  sessionId?: string | null;
  className?: string;
  /**
   * Show LFG's embedded first-run provider connection gate. Defaults to true.
   * Managed hosts that preselect a credential-free agent can disable this and
   * keep provider connections as an optional Settings action.
   */
  connectionOnboarding?: boolean;
  errorSink?: LfgErrorSink;
}

export declare function LfgAppSurface(
  props: LfgAppSurfaceProps,
): JSX.Element;

/**
 * Machine-owned settings pages a host can mount on their own, underneath its
 * own account and plan UI, instead of reimplementing them.
 */
export type LfgSettingsPage =
  | "settings"
  | "coding-agents"
  | "auto"
  | "storage"
  | "more";

export interface LfgSettingsSurfaceProps {
  transport: LfgTransport;
  assetBaseUrl?: string;
  /**
   * Which page to show. CONTROLLED when the host also passes `onNavigate`:
   * changing this prop navigates the surface, no remount required.
   */
  page?: LfgSettingsPage;
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
  onNavigate?: (page: LfgSettingsPage) => void;
  className?: string;
  errorSink?: LfgErrorSink;
}

export declare function LfgSettingsSurface(
  props: LfgSettingsSurfaceProps,
): JSX.Element;
