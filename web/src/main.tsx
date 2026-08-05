import { StrictMode } from "react";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as ReactDOM from "react-dom";
import "./index.css";
import { toast } from "sonner";
import { RouterProvider } from "@tanstack/react-router";
import { RootErrorBoundary } from "./App";
import { router } from "./router";
import { registerExtension } from "./lib/extensions";
import { installErrorReporting } from "./lib/report-error";
import { AppDialogProvider } from "@/components/ui/app-dialog";
import {
  applyTheme,
  getThemePreference,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
} from "./lib/theme";

// Capture uncaught errors + unhandled rejections and auto-report them to the
// backend (which surfaces a finding/push and dispatches an auto-fix agent).
// Installed first so an early-boot throw is still caught.
installErrorReporting();

// Runtime extension host. We expose the host's React (so external extension
// bundles share ONE React instead of bundling their own — hooks break with two)
// plus the registration API. serve.ts injects <script type="module"> tags for
// any LFG_EXTENSIONS URLs AFTER this bundle, so window.lfg exists before an
// extension runs. Open-source forks set no LFG_EXTENSIONS → no extensions load.
declare global {
  interface Window {
    lfg?: {
      React: typeof React;
      ReactDOM: typeof ReactDOM;
      jsxRuntime: typeof JsxRuntime;
      registerExtension: typeof registerExtension;
    };
  }
}
window.lfg = { React, ReactDOM, jsxRuntime: JsxRuntime, registerExtension };

applyTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  // Continue following the OS until the user makes an explicit selection.
  if (getThemePreference() !== null) return;
  applyTheme();
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
});
window.addEventListener("storage", (event) => {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  applyTheme();
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <AppDialogProvider>
        <RouterProvider router={router} />
      </AppDialogProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

// Close the loop for /__lfg_pwa_diag: this is the one report that separates "the
// app never ran" from "the app ran and painted nothing", which is the whole
// difference between a network/install bug and a UI bug. Sent on the next frame
// so it reflects a real paint rather than just a render call.
requestAnimationFrame(() => {
  const beacon = (window as unknown as { __lfgBeacon?: (phase: string, detail?: unknown) => void })
    .__lfgBeacon;
  beacon?.("app-mounted", {
    rootChildren: document.getElementById("root")?.children.length ?? -1,
    path: location.pathname,
  });
});

// Register the service worker for Web Push + a one-shot cache wipe on update.
// It intentionally does NOT intercept navigations or assets — that path made
// iOS home-screen installs solid black while Safari on the same origin worked.
// Each deploy ships a byte-different worker (serve.ts stamps VERSION); we lean
// on the native update lifecycle, adopt waiting workers on resume, and reload
// once on controllerchange.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerServiceWorker();
  });
}

function activateUpdate(worker: ServiceWorker) {
  worker.postMessage({ type: "SKIP_WAITING" });
}

function promptUpdate(worker: ServiceWorker) {
  toast("A new version of lfg is available", {
    description: "Reload to get the latest.",
    duration: Infinity,
    action: {
      label: "Reload",
      onClick: () => activateUpdate(worker),
    },
  });
}

async function registerServiceWorker() {
  try {
    // updateViaCache:"none" — iOS otherwise reuses a cached sw.js for update
    // checks, so installed PWAs never receive recovery workers after a deploy.
    const reg = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });

    // A worker updated during a previous visit may already be waiting. Activate
    // it immediately on startup so opening the PWA cannot strand the user on an
    // old app shell until they notice a toast.
    if (reg.waiting && navigator.serviceWorker.controller) {
      activateUpdate(reg.waiting);
    }

    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // "installed" while a controller already exists = an update (not the
        // first-ever install), so it's safe to offer the reload toast.
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          promptUpdate(installing);
        }
      });
    });

    // Cheap freshness checks — reg.update() is a conditional GET on sw.js, not a
    // full re-boot of the app. Run on an interval and when the tab refocuses.
    const check = () => {
      reg.update().catch(() => {});
    };
    setInterval(check, 60_000);

    // Adopt a pending update when the app is resumed from the background.
    //
    // The toast alone was not enough. An installed PWA — iOS especially — is
    // suspended rather than closed, so it can run the same shell for days: the
    // worker installs, waits, and the toast sits in a session the user is not
    // looking at, gets swiped away with the app, or is simply missed. The result
    // is a device pinned to an old build across many deploys while the server is
    // serving something newer, which reads as "my changes never shipped".
    //
    // Resume is the safe moment to take it: the app was backgrounded, so there
    // is no in-flight typing or scroll position worth more than being current,
    // and reloading here is the behaviour a native app update already has. While
    // the app is in the foreground we still only ever ask, never interrupt.
    const adoptPendingUpdate = () => {
      if (reg.waiting && navigator.serviceWorker.controller) {
        activateUpdate(reg.waiting);
      }
    };

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      adoptPendingUpdate();
      check();
    });
    window.addEventListener("focus", check);
  } catch {
    // Registration failed — the app still runs, just without offline/update UX.
  }

  // When a replacement worker takes control, reload once onto it. Skip the
  // first controller acquisition (new install) — reloading there races iOS
  // home-screen cold start and left fresh icons solid black.
  let refreshing = false;
  let seenController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!seenController) {
      seenController = true;
      return;
    }
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
