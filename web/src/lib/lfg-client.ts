import {
  createSameOriginTransport,
  type LfgSocket,
  type LfgTransport,
  type LfgUploadProgress,
} from "@lfg-dev/client";

// Standalone lfg and every embeddable host use the same transport contract.
// The standalone adapter is deliberately tiny because Vite/lfg serve keeps the
// UI and runtime on one origin; omg supplies the authenticated grant adapter.
let lfgTransport: LfgTransport = createSameOriginTransport();
let lfgAssetBaseUrl = "";

/**
 * Where a hosted surface mirrors client errors, in addition to reporting them
 * through the transport into the user's own lfg instance.
 *
 * Host-supplied rather than hardcoded: standalone and self-hosted lfg have no
 * business phoning a vendor endpoint, and the URL belongs to whoever is doing
 * the hosting.
 */
export type LfgErrorSink = {
  url: string;
  /** Short label for which host surface this is, e.g. "omg-dashboard". */
  surface?: string;
  /** Version of the embedded lfg app, so a report can be pinned to a build. */
  appVersion?: string;
};

let lfgErrorSinkConfig: LfgErrorSink | null = null;

/**
 * Installs the host-owned runtime boundary before the shared LFG application
 * mounts. Standalone LFG never calls this and keeps the same-origin adapter.
 */
export function configureLfgTransport(
  transport: LfgTransport,
  options: { assetBaseUrl?: string; errorSink?: LfgErrorSink } = {},
): void {
  lfgTransport = transport;
  lfgAssetBaseUrl = options.assetBaseUrl?.replace(/\/+$/, "") ?? "";
  lfgErrorSinkConfig = options.errorSink ?? null;
}

export function lfgErrorSink(): LfgErrorSink | null {
  return lfgErrorSinkConfig;
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return lfgTransport.request<T>(path, init);
}

export function lfgFetch(path: string, init?: RequestInit): Promise<Response> {
  return lfgTransport.fetch(path, init);
}

export function lfgUpload(
  path: string,
  init: RequestInit,
  onProgress: (progress: LfgUploadProgress) => void,
): Promise<Response> {
  return lfgTransport.upload?.(path, init, onProgress) ??
    lfgTransport.fetch(path, init);
}

export function openLfgLiveSocket(): Promise<LfgSocket> {
  return lfgTransport.openLiveSocket();
}

export function openLfgSocket(path: string): Promise<LfgSocket> {
  return lfgTransport.openSocket(path);
}

export function lfgAssetUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${lfgAssetBaseUrl}${normalizedPath}`;
}
