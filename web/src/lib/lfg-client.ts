import {
  createSameOriginTransport,
  type LfgSocket,
  type LfgTransport,
} from "@lfg-dev/client";

// Standalone lfg and every embeddable host use the same transport contract.
// The standalone adapter is deliberately tiny because Vite/lfg serve keeps the
// UI and runtime on one origin; omg supplies the authenticated grant adapter.
let lfgTransport: LfgTransport = createSameOriginTransport();
let lfgAssetBaseUrl = "";

/**
 * Installs the host-owned runtime boundary before the shared LFG application
 * mounts. Standalone LFG never calls this and keeps the same-origin adapter.
 */
export function configureLfgTransport(
  transport: LfgTransport,
  options: { assetBaseUrl?: string } = {},
): void {
  lfgTransport = transport;
  lfgAssetBaseUrl = options.assetBaseUrl?.replace(/\/+$/, "") ?? "";
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return lfgTransport.request<T>(path, init);
}

export function lfgFetch(path: string, init?: RequestInit): Promise<Response> {
  return lfgTransport.fetch(path, init);
}

export function openLfgLiveSocket(): Promise<LfgSocket> {
  return lfgTransport.openLiveSocket();
}

export function lfgAssetUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${lfgAssetBaseUrl}${normalizedPath}`;
}
