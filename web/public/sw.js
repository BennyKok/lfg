// lfg v2 service worker — makes the SPA installable + offline-capable for the
// app shell, without getting in the way of Vite's dev module graph or the
// streaming /api endpoints.
//
// Strategy: network-first for navigations and built assets (so a fresh deploy
// is picked up immediately when online, cache is only a fallback offline).
// Everything else — dev modules (/@vite, /src, /node_modules), websockets and
// the whole /api surface (SSE live streams!) — is passed straight through.
const CACHE = "lfg-v2-shell";
const BASE_PATH = typeof __LFG_BASE_PATH__ === "string" ? __LFG_BASE_PATH__ : "/";

function appPath(path) {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  if (!clean) return BASE_PATH;
  return BASE_PATH === "/" ? `/${clean}` : `${BASE_PATH}${clean}`;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const cleanup = [];
      for (const key of keys) {
        if (key !== CACHE) cleanup.push(caches.delete(key));
      }
      await Promise.all([...cleanup, self.clients.claim()]);
    })(),
  );
});

function cacheable(url, request) {
  if (url.pathname.startsWith(appPath("/api"))) return false; // never cache API / SSE
  if (request.mode === "navigate") return true;
  if (url.pathname.startsWith(appPath("/assets/"))) return true; // hashed Vite build output
  return /\.(svg|png|ico|webmanifest|woff2?)$/.test(url.pathname);
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
      icon: appPath("/icon.svg"),
      badge: appPath("/icon-maskable.svg"),
      tag: payload.tag || "lfg",
      renotify: true,
      data: { url: payload.url || appPath("/") },
    });
    return;
  }

  // Ask the backend for THIS device's feed only — filtered to the user this
  // push subscription is bound to, so we never show another user's question.
  let feedUrl = appPath("/api/ask?status=open");
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub?.endpoint) feedUrl = appPath(`/api/push/pending?endpoint=${encodeURIComponent(sub.endpoint)}`);
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
      icon: appPath("/icon.svg"),
      badge: appPath("/icon-maskable.svg"),
      tag: `ask-${q.id}`,
      renotify: true,
      requireInteraction: true,
      data: { url: appPath("/") },
    });
    return;
  }

  // Reuse the feed's findings if it carried them; else fetch the global list.
  const findings =
    asked?.findings || (await fetchJson(appPath("/api/auto/findings?status=open")))?.findings || [];
  const f = findings[0] || null;
  const title = f?.title || "lfg";
  const body =
    f?.suggest || (Array.isArray(f?.reasoning) ? f.reasoning[0] : "") || "New activity in your sessions";
  await self.registration.showNotification(title, {
    body,
    icon: appPath("/icon.svg"),
    badge: appPath("/icon-maskable.svg"),
    tag: f?.id ? `finding-${f.id}` : "lfg",
    renotify: true,
    data: { url: appPath("/"), findingId: f?.id || null },
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
  const target = event.notification.data?.url || appPath("/");
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
  if (!cacheable(url, request)) return; // pass through (dev modules, etc.)

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match(appPath("/"));
          if (shell) return shell;
        }
        throw new Error("offline");
      }
    })(),
  );
});
