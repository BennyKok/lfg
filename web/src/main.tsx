import { StrictMode } from "react";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as ReactDOM from "react-dom";
import "./index.css";
import { toast } from "sonner";
import { App, RootErrorBoundary } from "./App";
import { registerExtension } from "./lib/extensions";
import { installErrorReporting } from "./lib/report-error";

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

// Mirror the OS light/dark preference onto the `.dark` class the shadcn
// components key off (see @custom-variant dark in index.css). This is the
// React equivalent of lfg's prefers-color-scheme media queries.
function applyTheme() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
}
applyTheme();
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);

// Register the service worker so the app is installable, the shell works
// offline, and cache-first serving of the hashed /assets/* bundle makes reloads
// instant (see sw.js). Each deploy ships a byte-different worker, so we can lean
// on the native SW update lifecycle instead of polling for changed asset hashes:
// when a new worker finishes installing it sits in "waiting", and we surface a
// toast. The user clicks Reload → we tell the waiting worker to take over → the
// resulting controllerchange reloads the page once onto the fresh bundle. We
// never swap the running app out from under an in-progress session.
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
    const reg = await navigator.serviceWorker.register("/sw.js");

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
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    window.addEventListener("focus", check);
  } catch {
    // Registration failed — the app still runs, just without offline/update UX.
  }

  // When the freshly-activated worker takes control, reload once onto it.
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
