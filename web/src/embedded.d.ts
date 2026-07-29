import type { LfgTransport } from "@lfg-dev/client";
import type { JSX } from "react";

export interface LfgAppSurfaceProps {
  transport: LfgTransport;
  assetBaseUrl?: string;
  sessionId?: string | null;
  className?: string;
}

export declare function LfgAppSurface(
  props: LfgAppSurfaceProps,
): JSX.Element;
