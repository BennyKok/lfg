// lfg service worker — push notifications + install recovery only.
//
// ## Why this worker has no fetch handler
//
// From day one (June 2026) the worker intercepted navigations and /assets/* so
// the installed PWA felt offline-capable. On iOS standalone that fetch handler
// answers the navigation from its own cache. A stale shell naming deleted
// content-hashed chunks — or an empty/black cached document — produces a solid
// black window: the phone never requests the page, never runs our JavaScript,
// and nothing in the page can recover it. Safari on the same origin works
// because iOS keeps Safari website data and Home Screen web-app data separately.
//
// ## Why takeover must not depend on the Cache API
//
// July 30 (v0.1.141) put skipWaiting *after* cache work for a one-shot icon
// reset. That "await cache stuff, then skipWaiting" shape stayed as more reset
// markers piled up through early August. Any Cache API rejection (iOS storage
// pressure, an evicted bucket) then failed the install forever, leaving the old
// intercepting worker in charge — observed as dozens of /sw.js requests and
// zero document requests.
//
// Takeover is unconditional. Cache cleanup is best-effort only.
//
// ## What remains (and what was removed)
//
// Keep: VERSION stamp (byte-different worker per deploy), one generation
// marker, purge of historical shell/asset caches, push + badge handlers.
//
// Dropped: five historical one-shot KEEP markers (they only opened empty
// caches forever), unused cache-purge / unregister message handlers (the page
// already wipes via window.caches + unregister), and force-reloading open
// clients on activate. Client reload is owned by the page: Reload toast or
// cold-open adopt in main.tsx. Auto-navigating open windows on every deploy
// interrupted active product use.
//
// VERSION is overwritten at serve time from the live index stamp (see serve.ts).
const VERSION = "__VERSION__";
// Survives purges so later activates know the push-only generation is current.
// Older markers (crisp-icon, black-shell-v*, force-update, no-fetch) are deleted
// with everything else — they no longer need to stick around.
const GEN = "lfg-sw-gen-push-only-v1";

async function purgeStaleCaches(keys) {
  await Promise.all(
    keys.filter((key) => key !== GEN).map((key) => caches.delete(key)),
  );
}

// Taking over from a previous worker is the ONLY job that must never fail.
// Hand over control FIRST, unconditionally; treat every cache operation as
// best-effort housekeeping that is not allowed to block the handover.
// Claiming without a page reload is fine for a push-only worker (no fetch
// handler) — open tabs keep their current JS until Reload or cold open.
self.addEventListener("install", (event) => {
  // Not inside waitUntil and not awaited — nothing may sequence ahead of it.
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        if (!keys.includes(GEN)) await caches.open(GEN);
        // Drop historical shell/asset caches and the pile of old reset markers.
        await purgeStaleCaches(keys);
      } catch {
        // Housekeeping failed. The worker still installs: a running push-only
        // worker with a dirty cache beats a dead install behind a stale one.
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Claim first, for the same reason skipWaiting comes first above: this is
      // what actually removes the old worker from the navigation path.
      try {
        await self.clients.claim();
      } catch {
        // Claiming can fail transiently; the next launch controls regardless.
      }
      try {
        const keys = await caches.keys();
        await purgeStaleCaches(keys);
      } catch {
        // Best effort — see install.
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
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
