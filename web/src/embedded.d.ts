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
  errorSink?: LfgErrorSink;
}

export declare function LfgAppSurface(
  props: LfgAppSurfaceProps,
): JSX.Element;
