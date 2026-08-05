// lfg v2 service worker — makes the SPA installable + offline-capable for the
// app shell, without getting in the way of Vite's dev module graph or the
// streaming /api endpoints.
//
// Strategy:
//   • /assets/* (content-hashed, immutable build output) → CACHE-FIRST. The URL
//     changes whenever the bytes change, so a cache hit is always correct and a
//     reload is instant instead of paying a network round-trip per chunk.
//   • navigations + static shell files (icons, manifest, fonts) → NETWORK-FIRST
//     so a fresh deploy's index.html is picked up online, with a cache fallback
//     that keeps the installed PWA working offline.
//   • everything else — dev modules (/@vite, /src, /node_modules), websockets,
//     and the whole /api surface (SSE live streams!) — passes straight through.
//
// VERSION is stamped per build (see vite.config.ts), so each deploy ships a
// byte-different worker: the browser runs the install/activate lifecycle, the
// new caches replace the old ones, and every stale build's chunks are purged
// instead of accumulating forever.
//
// We always skipWaiting + claim + reload controlled clients on activate. A
// stuck black iOS PWA never reaches the in-app "Reload" toast, so waiting for
// user approval left phones on dead shells for days. Mid-session reloads after
// a deploy are acceptable; never updating is not.
const VERSION = "__VERSION__";
const SHELL_CACHE = `lfg-shell-${VERSION}`;
const ASSET_CACHE = `lfg-assets-${VERSION}`;
// One-time migration markers (kept forever once opened so each runs once).
//
//   • crisp-icon-v1 — v0.1.138 small icon.
//   • black-shell-v1/v2/v3 — black PWA recovery steps (purge / navigate / validate).
//   • force-update-v1 — always-activate installs so phones that finally fetch a
//     new sw.js take over immediately instead of sitting in "waiting".
const CRISP_ICON_CACHE_RESET = "lfg-cache-reset-crisp-icon-v1";
const BLACK_SHELL_CACHE_RESET_V1 = "lfg-cache-reset-black-shell-v1";
const BLACK_SHELL_CACHE_RESET_V2 = "lfg-cache-reset-black-shell-v2";
const BLACK_SHELL_CACHE_RESET_V3 = "lfg-cache-reset-black-shell-v3";
const FORCE_UPDATE_RESET = "lfg-cache-reset-force-update-v1";
const KEEP = new Set([
  SHELL_CACHE,
  ASSET_CACHE,
  CRISP_ICON_CACHE_RESET,
  BLACK_SHELL_CACHE_RESET_V1,
  BLACK_SHELL_CACHE_RESET_V2,
  BLACK_SHELL_CACHE_RESET_V3,
  FORCE_UPDATE_RESET,
]);

async function purgeShellAndAssetCaches(keys) {
  await Promise.all(
    keys
      .filter((key) => key.startsWith("lfg-shell-") || key.startsWith("lfg-assets-"))
      .map((key) => caches.delete(key)),
  );
}

async function reloadControlledClients() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  await Promise.all(
    all.map(async (client) => {
      try {
        if ("navigate" in client) {
          await client.navigate(client.url || "/");
          return;
        }
      } catch {
        // fall through
      }
      try {
        client.postMessage({ type: "LFG_FORCE_RELOAD" });
      } catch {
        // client may be gone
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Open any missing migration markers and always purge shell/asset caches
      // when this is the first worker carrying force-update-v1 (or an older
      // black-shell marker the device never received).
      const needsPurge =
        !keys.includes(FORCE_UPDATE_RESET) ||
        !keys.includes(BLACK_SHELL_CACHE_RESET_V3);
      for (const marker of [
        FORCE_UPDATE_RESET,
        BLACK_SHELL_CACHE_RESET_V3,
        BLACK_SHELL_CACHE_RESET_V2,
        BLACK_SHELL_CACHE_RESET_V1,
        CRISP_ICON_CACHE_RESET,
      ]) {
        if (!keys.includes(marker)) await caches.open(marker);
      }
      if (needsPurge) await purgeShellAndAssetCaches(keys);
      // Always activate immediately — do not wait for a toast the black
      // screen can never show.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !KEEP.has(key)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
      await reloadControlledClients();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "PURGE_SHELL_CACHES") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await purgeShellAndAssetCaches(keys);
      })(),
    );
  }
  if (event.data?.type === "UNREGISTER_AND_RELOAD") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister();
        await reloadControlledClients();
      })(),
    );
  }
});

// Immutable, content-hashed build output — safe to serve from cache forever.
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

// Static shell files worth an offline fallback (served network-first).
function isShell(url, request) {
  if (request.mode === "navigate") return true;
  // iOS standalone sometimes issues document loads without mode=navigate.
  if (request.destination === "document") return true;
  return /\.(svg|png|ico|webmanifest|woff2?)$/.test(url.pathname);
}

function offlineShellResponse() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#000000"/>
<title>lfg — offline</title>
<style>
  html,body{margin:0;min-height:100%;background:#000;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}
  main{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem;text-align:center;gap:1rem}
  h1{font-size:1.15rem;font-weight:600;margin:0}
  p{margin:0;max-width:22rem;line-height:1.45;color:#a1a1aa;font-size:.95rem}
  button{appearance:none;border:0;border-radius:999px;padding:.7rem 1.15rem;font:inherit;font-weight:600;background:#0a84ff;color:#fff}
  button.secondary{background:#27272a;color:#f4f4f5}
  .row{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;margin-top:.5rem}
</style>
</head>
<body>
<main>
  <h1>Can't reach this lfg box</h1>
  <p>The installed app is offline or the server did not answer. Check Tailscale / network, then retry. If it stays black after you are online, clear the stale shell cache.</p>
  <div class="row">
    <button type="button" id="retry">Retry</button>
    <button type="button" class="secondary" id="reset">Clear cache &amp; reload</button>
  </div>
</main>
<script>
document.getElementById("retry").onclick=function(){location.reload()};
document.getElementById("reset").onclick=async function(){
  try{
    if(navigator.serviceWorker&&navigator.serviceWorker.controller){
      navigator.serviceWorker.controller.postMessage({type:"PURGE_SHELL_CACHES"});
    }
    var keys=await caches.keys();
    await Promise.all(keys.filter(function(k){return k.indexOf("lfg-shell-")===0||k.indexOf("lfg-assets-")===0}).map(function(k){return caches.delete(k)}));
    var regs=await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(function(r){return r.unregister()}));
  }catch(e){}
  location.replace("/?pwa_reset="+Date.now());
};
</script>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// A usable app shell must be the real index (splash + entry script), not an
// empty black document someone accidentally cached. Serving the latter as an
// offline fallback is exactly "completely black, no chrome".
async function isUsableAppShell(response) {
  if (!response || !response.ok) return false;
  const type = response.headers.get("content-type") || "";
  if (type && !type.includes("text/html") && !type.includes("application/xhtml")) {
    return false;
  }
  try {
    const text = await response.clone().text();
    if (text.length < 200) return false;
    const hasSplash = text.includes("app-splash") || text.includes("id=\"root\"");
    const hasEntry =
      text.includes("/assets/index-") ||
      text.includes("/src/main.tsx") ||
      text.includes("did not finish loading");
    return hasSplash && hasEntry;
  } catch {
    return false;
  }
}

async function matchUsableShell(request) {
  const candidates = [request, "/", "/index.html"];
  for (const key of candidates) {
    const cached = await caches.match(key);
    if (cached && (await isUsableAppShell(cached))) return cached;
  }
  return null;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(ASSET_CACHE).then((c) => c.put(request, copy)).catch(() => {});
  }
  return response;
}

async function networkFirst(request) {
  const isDocument =
    request.mode === "navigate" || request.destination === "document";
  try {
    // Bypass the HTTP cache so a stuck installed PWA cannot keep a dead
    // index.html that names deleted /assets/* chunks.
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      if (!isDocument || (await isUsableAppShell(response))) {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
      }
    }
    // Online but the origin returned a useless document — do not paint black.
    if (isDocument && response && response.ok && !(await isUsableAppShell(response))) {
      return offlineShellResponse();
    }
    return response;
  } catch {
    if (isDocument) {
      const shell = await matchUsableShell(request);
      if (shell) return shell;
      return offlineShellResponse();
    }
    const cached = await caches.match(request);
    if (cached) return cached;
    throw new Error("offline");
  }
}

// ── Web Push ────────────────────────────────────────────────────────────────
// Pushes are payload-less: when one arrives we fetch what's pending (same data
// the UI polls) and raise a notification. Event-specific notices queued by the
// backend win, then a pending agent QUESTION, then a finding. If a future push
// ever carries a JSON payload we honour that first.
async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {
    // offline / API down
  }
  return null;
}

// Keep the installed app icon's badge aligned with currently visible
// notifications. The Badging API is progressive enhancement: unsupported
// browsers simply keep the ordinary system notification.
async function syncAppBadge() {
  if (!self.navigator?.setAppBadge || !self.navigator?.clearAppBadge) return;
  try {
    const visible = await self.registration.getNotifications();
    if (visible.length) await self.navigator.setAppBadge(visible.length);
    else await self.navigator.clearAppBadge();
  } catch {
    // Badging can be unavailable or denied independently of notifications.
  }
}

async function showLfgNotification(title, options) {
  await self.registration.showNotification(title, options);
  await syncAppBadge();
}

async function showLatest(payload) {
  if (payload?.title) {
    await showLfgNotification(payload.title, {
      body: payload.body || "",
      icon: "/icon.svg",
      badge: "/icon-maskable.svg",
      tag: payload.tag || "lfg",
      renotify: true,
      data: { url: payload.url || "/" },
    });
    return;
  }

  // Ask the backend for THIS device's feed only — filtered to the user this
  // push subscription is bound to, so we never show another user's question.
  let feedUrl = "/api/ask?status=open";
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub?.endpoint) feedUrl = `/api/push/pending?endpoint=${encodeURIComponent(sub.endpoint)}`;
  } catch {
    // no subscription handle — fall back to the unscoped list
  }

  // A server-queued notice identifies the exact event that caused this
  // payload-less wake (for example, a shipped result and its session link).
  const asked = await fetchJson(feedUrl);
  const notification = asked?.notification || null;
  if (notification?.title) {
    await showLfgNotification(notification.title, {
      body: notification.body || "",
      icon: "/icon.svg",
      badge: "/icon-maskable.svg",
      tag: notification.tag || "lfg",
      renotify: true,
      data: { url: notification.url || "/" },
    });
    return;
  }

  // Prefer an open question over a finding.
  const q = (asked?.questions || [])[0] || null;
  if (q) {
    const opts = Array.isArray(q.options) && q.options.length ? ` — ${q.options.join(" / ")}` : "";
    await showLfgNotification("lfg needs your input", {
      body: (q.question || "A question is waiting") + opts,
      icon: "/icon.svg",
      badge: "/icon-maskable.svg",
      tag: `ask-${q.id}`,
      renotify: true,
      requireInteraction: true,
      data: { url: "/" },
    });
    return;
  }

  // Reuse the feed's findings if it carried them; else fetch the global list.
  const findings =
    asked?.findings || (await fetchJson("/api/auto/findings?status=open"))?.findings || [];
  const f = findings[0] || null;
  const title = f?.title || "lfg";
  const body =
    f?.suggest || (Array.isArray(f?.reasoning) ? f.reasoning[0] : "") || "New activity in your sessions";
  await showLfgNotification(title, {
    body,
    icon: "/icon.svg",
    badge: "/icon-maskable.svg",
    tag: f?.id ? `finding-${f.id}` : "lfg",
    renotify: true,
    data: { url: "/", findingId: f?.id || null },
  });
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  event.waitUntil(showLatest(payload));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      await syncAppBadge();
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all.find((c) => "focus" in c);
      if (client) {
        if ("navigate" in client) await client.navigate(target);
        await client.focus();
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(target);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api")) return; // never cache API / SSE
  // Always network for the reset escape hatch — never a cached black shell.
  if (url.pathname === "/__lfg_pwa_reset") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (isShell(url, request)) {
    event.respondWith(networkFirst(request));
    return;
  }
  // pass through — dev modules (/@vite, /src, /node_modules), etc.
});
