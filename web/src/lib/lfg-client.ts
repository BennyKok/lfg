import { createSameOriginTransport } from "@lfg-dev/client";

// Standalone lfg and every embeddable host use the same transport contract.
// The standalone adapter is deliberately tiny because Vite/lfg serve keeps the
// UI and runtime on one origin; omg supplies the authenticated grant adapter.
export const lfgTransport = createSameOriginTransport();

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return lfgTransport.request<T>(path, init);
}
