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
// instead of accumulating forever. We do NOT skipWaiting on our own — the page
// shows a toast and only tells us to take over (SKIP_WAITING) when the user
// clicks Reload, so we never swap assets out from under a live session.
const VERSION = "__VERSION__";
const SHELL_CACHE = `lfg-shell-${VERSION}`;
const ASSET_CACHE = `lfg-assets-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, ASSET_CACHE]);

self.addEventListener("install", () => {
  // Stay in "waiting" until the page asks us to activate (SKIP_WAITING).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !KEEP.has(key)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// Immutable, content-hashed build output — safe to serve from cache forever.
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

// Static shell files worth an offline fallback (served network-first).
function isShell(url, request) {
  if (request.mode === "navigate") return true;
  return /\.(svg|png|ico|webmanifest|woff2?)$/.test(url.pathname);
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
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.match("/");
      if (shell) return shell;
    }
    throw new Error("offline");
  }
}

// ── Web Push ────────────────────────────────────────────────────────────────
// Pushes are payload-less: when one arrives we fetch what's pending (same data
// the UI polls) and raise a notification. A pending agent QUESTION wins over a
// finding — it's interactive and needs a human reply. If a future push ever
// carries a JSON payload we honour that first.
async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {
    // offline / API down
  }
  return null;
}

async function showLatest(payload) {
  if (payload?.title) {
    await self.registration.showNotification(payload.title, {
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

  // Prefer an open question over a finding.
  const asked = await fetchJson(feedUrl);
  const q = (asked?.questions || [])[0] || null;
  if (q) {
    const opts = Array.isArray(q.options) && q.options.length ? ` — ${q.options.join(" / ")}` : "";
    await self.registration.showNotification("lfg needs your input", {
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
  await self.registration.showNotification(title, {
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
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all.find((c) => "focus" in c);
      if (client) {
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
