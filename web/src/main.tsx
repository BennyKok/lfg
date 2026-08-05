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

// Tell the boot shell the entry module is evaluating. Cancels the stuck-splash
// recovery timer so a slow first paint after a successful download never shows
// "lfg did not finish loading" for a second and then the real UI.
(
  window as unknown as { __lfgMarkAppModule?: () => void }
).__lfgMarkAppModule?.();

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

// Service-worker UX that needs the app bundle (toast + cold-open adopt).
// Boot-critical registration and stuck-splash recovery live in index.html so
// they still run when this module never loads.
// The worker itself does NOT intercept navigations or assets — that path made
// iOS home-screen installs solid black while Safari on the same origin worked.
//
// Update policy: never hard-reload an active session. Reload only when the user
// taps Reload on the toast, or automatically on cold open when a worker is
// already waiting from a previous visit.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerServiceWorker();
  });
}

function activateUpdate(worker: ServiceWorker) {
  // Hand control to the waiting worker, then hard-reload this document.
  //
  // Callers are only the Reload toast action and cold-open adopt. Do not rely
  // on controllerchange for the page bounce: install already skipWaits, so by
  // the time the user taps Reload the worker is often already active and no
  // second controllerchange will fire. The push-only worker does not intercept
  // assets — a document reload is what actually picks up the new shell.
  try {
    worker.postMessage({ type: "SKIP_WAITING" });
  } catch {
    // Worker may already be gone; still reload.
  }
  window.location.reload();
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
    // Idempotent with the early register() in index.html (same URL/scope).
    const reg = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });

    // Cold open only: a worker that installed during a previous visit may still
    // be waiting. Taking it on startup is safe — there is no in-flight work —
    // and avoids stranding a closed-and-reopened PWA on an old shell until the
    // user notices a toast. Do NOT do this on resume/focus; that interrupted
    // active product use when deploys landed while the app was backgrounded.
    if (reg.waiting && navigator.serviceWorker.controller) {
      activateUpdate(reg.waiting);
      return;
    }

    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // "installed" while a controller already exists = an update (not the
        // first-ever install). Offer Reload; never force it mid-session.
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          promptUpdate(installing);
        }
      });
    });

    // Cheap freshness checks — reg.update() is a conditional GET on sw.js, not a
    // full re-boot of the app. Run on an interval and when the tab refocuses so
    // the toast can appear; never auto-reload from these paths.
    const check = () => {
      reg.update().catch(() => {});
    };
    setInterval(check, 60_000);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      check();
    });
    window.addEventListener("focus", check);
  } catch {
    // Registration failed — the app still runs, just without push/update UX.
  }
}
