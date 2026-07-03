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

const UPDATE_PROBE_PARAM = "lfg_update_probe";
const isUpdateProbe = new URLSearchParams(window.location.search).has(UPDATE_PROBE_PARAM);
const CURRENT_BUILD =
  document
    .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
    ?.src.match(/index-[\w-]+\.js/)?.[0] ?? null;

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

async function signalUpdateProbeReady() {
  const stylesheets = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  );
  await Promise.all(
    stylesheets.map(
      (link) =>
        link.sheet ||
        new Promise<void>((resolve) => {
          link.addEventListener("load", () => resolve(), { once: true });
          link.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  window.parent?.postMessage(
    { type: "lfg:update-probe-ready", build: CURRENT_BUILD },
    window.location.origin,
  );
}

if (isUpdateProbe) {
  document.documentElement.style.background = "transparent";
  void signalUpdateProbeReady();
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </StrictMode>,
  );
}

// Register the service worker so the app is installable and the shell works
// offline. Network-first (see sw.js) keeps it from serving stale builds.
if (!isUpdateProbe && "serviceWorker" in navigator) {
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
if (!isUpdateProbe && CURRENT_BUILD) {
  let reloading = false;
  let updateProbeFrame: HTMLIFrameElement | null = null;

  type BuildSnapshot = {
    entry: string;
    assets: string[];
  };

  const parseBuildSnapshot = (html: string): BuildSnapshot | null => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const entrySrc =
      doc
        .querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
        ?.getAttribute("src") ?? "";
    const entry = entrySrc.match(/index-[\w-]+\.js/)?.[0] ?? null;
    if (!entry) return null;
    const assets = [
      entrySrc,
      ...Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href^="/assets/"]'))
        .map((link) => link.getAttribute("href"))
        .filter((href): href is string => !!href),
    ].map((path) => new URL(path, window.location.origin).pathname);
    return { entry, assets: Array.from(new Set(assets)) };
  };

  const latestBuild = async (): Promise<BuildSnapshot | null> => {
    try {
      const res = await fetch("/", { cache: "reload" });
      if (!res.ok) return null;
      return parseBuildSnapshot(await res.text());
    } catch {
      return null; // offline / transient — try again on the next tick
    }
  };

  const freshAssetsReady = async (snapshot: BuildSnapshot): Promise<boolean> => {
    try {
      const results = await Promise.all(
        snapshot.assets.map(async (path) => {
          const res = await fetch(path, { cache: "reload" });
          if (!res.ok) return false;
          const contentType = res.headers.get("content-type") ?? "";
          if (path.endsWith(".js")) return contentType.includes("javascript");
          if (path.endsWith(".css")) return contentType.includes("text/css");
          return true;
        }),
      );
      return results.every(Boolean);
    } catch {
      return false;
    }
  };

  const stagedBuildReady = async (snapshot: BuildSnapshot): Promise<boolean> => {
    if (!document.body) return false;
    updateProbeFrame?.remove();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanup = (ready: boolean) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        window.clearTimeout(timeout);
        updateProbeFrame?.remove();
        updateProbeFrame = null;
        resolve(ready);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; build?: string } | null;
        if (data?.type !== "lfg:update-probe-ready") return;
        cleanup(data.build === snapshot.entry);
      };
      const timeout = window.setTimeout(() => cleanup(false), 15_000);
      window.addEventListener("message", onMessage);

      const frame = document.createElement("iframe");
      frame.tabIndex = -1;
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText =
        "position:fixed;left:-1px;top:-1px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
      frame.src = `/?${UPDATE_PROBE_PARAM}=${encodeURIComponent(snapshot.entry)}&t=${Date.now()}`;
      updateProbeFrame = frame;
      document.body.appendChild(frame);
    });
  };

  const checkForUpdate = async () => {
    if (reloading) return;
    const latest = await latestBuild();
    if (!latest || latest.entry === CURRENT_BUILD) return;
    // A deploy restart can briefly expose the new index before every hashed asset
    // is reachable. If we reload in that window, the service worker may serve the
    // new shell from cache but miss the entry module, leaving an installed PWA on a
    // blank page. Prove and warm the fresh entry/CSS first; retry on the next tick.
    if (!(await freshAssetsReady(latest))) return;
    // Then boot that fresh bundle in a hidden probe frame. Only reload the visible
    // PWA after the new entry has evaluated and its stylesheet has loaded.
    if (!(await stagedBuildReady(latest))) return;
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
