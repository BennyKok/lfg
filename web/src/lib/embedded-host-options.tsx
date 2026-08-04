import { createContext, useContext, type ReactNode } from "react";

export interface EmbeddedHostOptions {
  /**
   * Whether LFG should own the first-run provider connection gate. A managed
   * host can disable it when it has already selected a credential-free agent
   * and exposes provider connections later in its own Settings surface.
   */
  connectionOnboarding: boolean;
  /**
   * Presentation-only identity supplied by an embedding host. It is deliberately
   * separate from LFG's roster: a hosted Computer is already account-scoped,
   * and showing its viewer must never assign sessions or change authorization.
   */
  viewer?: EmbeddedViewer;
}

export interface EmbeddedViewer {
  id: string;
  name: string;
  avatar?: string;
}

const EmbeddedHostOptionsContext = createContext<EmbeddedHostOptions>({
  connectionOnboarding: true,
});

export function EmbeddedHostOptionsProvider({
  value,
  children,
}: {
  value: EmbeddedHostOptions;
  children: ReactNode;
}) {
  return (
    <EmbeddedHostOptionsContext.Provider value={value}>
      {children}
    </EmbeddedHostOptionsContext.Provider>
  );
}

export function useEmbeddedHostOptions(): EmbeddedHostOptions {
  return useContext(EmbeddedHostOptionsContext);
}
