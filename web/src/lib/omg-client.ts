import {
  createSameOriginTransport,
  type OmgSocket,
  type OmgTransport,
  type OmgUploadProgress,
} from "@omg-dev/client";

// Standalone lfg and every embeddable host use the same transport contract.
// The standalone adapter is deliberately tiny because Vite/lfg serve keeps the
// UI and runtime on one origin; omg supplies the authenticated grant adapter.
let omgTransport: OmgTransport = createSameOriginTransport();
let omgAssetBaseUrl = "";

/**
 * Where a hosted surface mirrors client errors, in addition to reporting them
 * through the transport into the user's own lfg instance.
 *
 * Host-supplied rather than hardcoded: standalone and self-hosted lfg have no
 * business phoning a vendor endpoint, and the URL belongs to whoever is doing
 * the hosting.
 */
export type OmgErrorSink = {
  url: string;
  /** Short label for which host surface this is, e.g. "omg-dashboard". */
  surface?: string;
  /** Version of the embedded lfg app, so a report can be pinned to a build. */
  appVersion?: string;
};

let omgErrorSinkConfig: OmgErrorSink | null = null;

/**
 * Installs the host-owned runtime boundary before the shared LFG application
 * mounts. Standalone LFG never calls this and keeps the same-origin adapter.
 */
export function configureOmgTransport(
  transport: OmgTransport,
  options: { assetBaseUrl?: string; errorSink?: OmgErrorSink } = {},
): void {
  omgTransport = transport;
  omgAssetBaseUrl = options.assetBaseUrl?.replace(/\/+$/, "") ?? "";
  omgErrorSinkConfig = options.errorSink ?? null;
}

export function omgErrorSink(): OmgErrorSink | null {
  return omgErrorSinkConfig;
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return omgTransport.request<T>(path, init);
}

export function omgFetch(path: string, init?: RequestInit): Promise<Response> {
  return omgTransport.fetch(path, init);
}

export function omgUpload(
  path: string,
  init: RequestInit,
  onProgress: (progress: OmgUploadProgress) => void,
): Promise<Response> {
  return omgTransport.upload?.(path, init, onProgress) ??
    omgTransport.fetch(path, init);
}

export function openOmgLiveSocket(): Promise<OmgSocket> {
  return omgTransport.openLiveSocket();
}

export function openOmgSocket(path: string): Promise<OmgSocket> {
  return omgTransport.openSocket(path);
}

export function omgAssetUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${omgAssetBaseUrl}${normalizedPath}`;
}
