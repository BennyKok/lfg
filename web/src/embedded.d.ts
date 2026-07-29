import type { LfgTransport } from "@lfg-dev/client";
import type { JSX } from "react";

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
}

export declare function LfgAppSurface(
  props: LfgAppSurfaceProps,
): JSX.Element;
