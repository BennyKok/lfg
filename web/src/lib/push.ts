import { appPath } from "./base-path";

// Client-side Web Push enrolment. Talks to /api/push/* and the service worker
// registered in main.tsx. Payload-less: the SW fetches the finding itself, so
// here we only manage the subscription lifecycle.

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True only where the browser can actually do Web Push (needs HTTPS + SW). */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** "granted" | "denied" | "default" | "unsupported" */
export function pushPermission(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

/** Whether this browser already holds a live push subscription. */
export async function isSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

/**
 * Ask permission, subscribe with the server's VAPID key, and register the
 * subscription with the backend. Returns true on success. Throws only on a
 * hard, surfaceable error (permission denied is returned as false).
 */
export async function enablePush(user?: string | null): Promise<boolean> {
  if (!pushSupported()) throw new Error("Push notifications aren't supported here");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const keyRes = await fetch(appPath("/api/push/vapid"));
  if (!keyRes.ok) throw new Error("Could not load push key");
  const { key } = (await keyRes.json()) as { key: string };

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    });
  }

  const json = sub.toJSON() as { endpoint?: string; keys?: Record<string, string> };
  await fetch(appPath("/api/push/subscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, user: user ?? null }),
  });
  return true;
}

/** Unsubscribe locally and tell the backend to forget this endpoint. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch(appPath("/api/push/unsubscribe"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}
