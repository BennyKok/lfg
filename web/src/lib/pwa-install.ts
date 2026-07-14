import { useSyncExternalStore } from "react";

export type PwaInstallMode = "native" | "ios" | "mac-safari" | "none";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type PwaInstallSnapshot = {
  installed: boolean;
  mode: PwaInstallMode;
};

const listeners = new Set<() => void>();
let deferredPrompt: BeforeInstallPromptEvent | null = null;

function isStandalone() {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigatorWithStandalone.standalone === true
  );
}

function manualInstallMode(): PwaInstallMode {
  const ua = navigator.userAgent;
  const appleMobile =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (appleMobile) return "ios";

  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua);
  if (safari && /Mac/.test(navigator.platform)) return "mac-safari";
  return "none";
}

let snapshot: PwaInstallSnapshot = {
  installed: isStandalone(),
  mode: isStandalone() ? "none" : manualInstallMode(),
};

function publish(next: PwaInstallSnapshot) {
  if (snapshot.installed === next.installed && snapshot.mode === next.mode) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function syncInstalledState() {
  const installed = isStandalone();
  publish({
    installed,
    mode: installed ? "none" : deferredPrompt ? "native" : manualInstallMode(),
  });
}

window.addEventListener("beforeinstallprompt", (event) => {
  // Keep the one-shot browser event until the user chooses our visible Install
  // action. Chromium does not expose this flow on iOS or Safari.
  event.preventDefault();
  deferredPrompt = event as BeforeInstallPromptEvent;
  publish({ installed: false, mode: "native" });
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  publish({ installed: true, mode: "none" });
});

window.matchMedia("(display-mode: standalone)").addEventListener("change", syncInstalledState);

export function usePwaInstall() {
  const state = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );

  return {
    ...state,
    install: async () => {
      const prompt = deferredPrompt;
      if (!prompt) return false;
      await prompt.prompt();
      const choice = await prompt.userChoice;
      deferredPrompt = null;
      if (choice.outcome === "accepted") {
        publish({ installed: true, mode: "none" });
        return true;
      }
      publish({ installed: false, mode: manualInstallMode() });
      return false;
    },
  };
}
