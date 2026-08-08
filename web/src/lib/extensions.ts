// LFG runtime extension system.
//
// LFG core ships ONLY this loader + a registration API — no proprietary
// features. At runtime the server (serve.ts) injects `<script type="module">`
// tags for any URLs in the LFG_EXTENSIONS env; those external bundles call
// window.lfg.registerExtension(...) to contribute UI (e.g. a bottom-nav tab).
//
// Set no LFG_EXTENSIONS → nothing loads → a clean core. Operators point it at
// their own private bundles (hosted anywhere), so proprietary surfaces mount at
// runtime and never live in this tree.
//
// React is SHARED from the host (exposed on window.lfg.React + jsxRuntime) so
// an extension bundle marks react/react-dom external and uses the host's copy —
// one React instance, hooks work across the boundary.

import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export interface ExtensionNavTab {
  id: string;
  label: string;
  icon?: ReactNode;
  render: () => ReactNode;
}

export interface OmgExtension {
  id: string;
  navTabs?: ExtensionNavTab[];
}

let extensions: OmgExtension[] = [];
const listeners = new Set<() => void>();
function emit() {
  // New array identity so useSyncExternalStore sees a change.
  extensions = extensions.slice();
  for (const l of listeners) l();
}

/** Called by external extension bundles (via window.lfg) to contribute UI. */
export function registerExtension(ext: OmgExtension) {
  if (!ext || typeof ext.id !== "string") return;
  if (extensions.some((e) => e.id === ext.id)) return; // idempotent
  extensions = [...extensions, ext];
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function snapshot() {
  return extensions;
}

/** React hook: the live list of registered extensions (re-renders on register). */
export function useExtensions(): OmgExtension[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Flattened nav-tab contributions across all extensions. */
export function useExtensionNavTabs(): ExtensionNavTab[] {
  return useExtensions().flatMap((e) => e.navTabs ?? []);
}
