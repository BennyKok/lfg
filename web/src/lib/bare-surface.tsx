// Whether THIS tree is a single page mounted inside a host's own chrome.
//
// This used to be a module-level boolean set by the package entry point, on the
// reasoning that the decision is made once before any React tree exists. That
// holds for one surface per document — and omg mounts two. It keeps the
// Computer surface (the full app) alive off-screen while you open Settings (a
// bare page), so the two coexist and a single global cannot describe both: the
// settings page set it true, and from then on every full-app render read as
// bare, losing its header, its gutter and its header inset until a hard reload.
//
// A context is the honest shape. `bare` is a property of a tree, not of the
// process, and each surface declares its own.

import { createContext, useContext, type ReactNode } from "react";
import { isBareSurface } from "./embed";

const BareSurfaceContext = createContext<boolean | null>(null);

export function BareSurfaceProvider({
  bare,
  children,
}: {
  bare: boolean;
  children: ReactNode;
}) {
  return <BareSurfaceContext.Provider value={bare}>{children}</BareSurfaceContext.Provider>;
}

/**
 * True when this tree renders sections only and the host owns the chrome.
 *
 * Falls back to the module flag / `?bare=1` when no provider is present, which
 * is how the standalone app and a plain-browser inspection of the hosted layout
 * keep working.
 */
export function useBareSurface(): boolean {
  const fromTree = useContext(BareSurfaceContext);
  const fallback = isBareSurface();
  return fromTree ?? fallback;
}
