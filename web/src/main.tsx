import { StrictMode } from "react";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as ReactDOM from "react-dom";
import "./index.css";
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

// Register the service worker so the app is installable and the shell works
// offline. Network-first (see sw.js) keeps it from serving stale builds.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ── auto-update ────────────────────────────────────────────────────────────
// sw.js is byte-identical across builds, so the browser never fires a SW
// update event — an open tab/installed PWA would otherwise sit on its old JS
// forever. Instead we watch the hashed entry chunk: read the one this document
// loaded, then poll the live index.html for its current hash. When they differ
// a new build is published, so reload (the network-first SW then serves the
// fresh shell + assets). In dev there's no hashed asset, so CURRENT stays null
// and this whole block no-ops — Vite HMR owns that path.
const CURRENT_BUILD =
  document
    .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
    ?.src.match(/index-[\w-]+\.js/)?.[0] ?? null;

if (CURRENT_BUILD) {
  let reloading = false;

  const latestBuild = async (): Promise<string | null> => {
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.text()).match(/index-[\w-]+\.js/)?.[0] ?? null;
    } catch {
      return null; // offline / transient — try again on the next tick
    }
  };

  const checkForUpdate = async () => {
    if (reloading) return;
    const latest = await latestBuild();
    if (!latest || latest === CURRENT_BUILD) return;
    // Don't yank the page out from under an in-progress message — defer the
    // reload to the next check once the composer isn't focused.
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    reloading = true;
    window.location.reload();
  };

  setInterval(() => void checkForUpdate(), 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  });
  window.addEventListener("focus", () => void checkForUpdate());
}
