// lfg service worker — push + install recovery only.
//
// History: we used to intercept navigations and /assets/* so the installed PWA
// felt offline-capable. On iOS that fetch handler made home-screen installs go
// solid black while Safari/Chrome worked. This worker has NO fetch handler.
//
// Also: we must NOT reload every client on every activate. Doing so on a brand
// new home-screen install caused a reload storm (install → activate → navigate
// → controllerchange → reload) that left real iPhones on a black screen even
// after the user deleted every icon. Only reload when upgrading off an old
// shell/asset cache generation.
//
// VERSION is overwritten at serve time from the live index stamp (see serve.ts).
const VERSION = "__VERSION__";
const CRISP_ICON_CACHE_RESET = "lfg-cache-reset-crisp-icon-v1";
const BLACK_SHELL_CACHE_RESET_V1 = "lfg-cache-reset-black-shell-v1";
const BLACK_SHELL_CACHE_RESET_V2 = "lfg-cache-reset-black-shell-v2";
const BLACK_SHELL_CACHE_RESET_V3 = "lfg-cache-reset-black-shell-v3";
const FORCE_UPDATE_RESET = "lfg-cache-reset-force-update-v1";
const NO_FETCH_RESET = "lfg-cache-reset-no-fetch-v1";
const KEEP = new Set([
  CRISP_ICON_CACHE_RESET,
  BLACK_SHELL_CACHE_RESET_V1,
  BLACK_SHELL_CACHE_RESET_V2,
  BLACK_SHELL_CACHE_RESET_V3,
  FORCE_UPDATE_RESET,
  NO_FETCH_RESET,
]);

// Set during install when this activation should bounce open windows once.
let reloadClientsOnActivate = false;

async function purgeAllLfgCaches(keys) {
  await Promise.all(
    keys
      .filter(
        (key) =>
          key.startsWith("lfg-shell-") ||
          key.startsWith("lfg-assets-") ||
          (key.startsWith("lfg-") && !KEEP.has(key)),
      )
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
      const hadShellCaches = keys.some(
        (key) => key.startsWith("lfg-shell-") || key.startsWith("lfg-assets-"),
      );
      for (const marker of KEEP) {
        if (!keys.includes(marker)) await caches.open(marker);
      }
      if (hadShellCaches) {
        await purgeAllLfgCaches(keys);
        // Only bounce clients when we actually cleaned a stale shell generation.
        // Brand-new installs have no shell caches — reloading them on first
        // activate is what left fresh home-screen icons black.
        reloadClientsOnActivate = true;
      }
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
      if (reloadClientsOnActivate) {
        reloadClientsOnActivate = false;
        await reloadControlledClients();
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "PURGE_SHELL_CACHES") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await purgeAllLfgCaches(keys);
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

// ── Web Push only (no fetch handler) ────────────────────────────────────────
async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {
    // offline / API down
  }
  return null;
}

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

  let feedUrl = "/api/ask?status=open";
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub?.endpoint) feedUrl = `/api/push/pending?endpoint=${encodeURIComponent(sub.endpoint)}`;
  } catch {
    // no subscription
  }

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
