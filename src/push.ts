// Web Push (PWA notifications) — payload-less VAPID push.
//
// We deliberately send *payload-less* pushes: the only crypto we need is the
// VAPID JWT (ES256 over P-256) that authenticates us to the push service. The
// heavy RFC 8291 aes128gcm payload encryption is skipped entirely. When a push
// arrives, the service worker wakes and fetches the latest open finding from
// /api/auto/findings to build the notification — reusing the same data the UI
// already polls. Zero extra npm dependencies; Bun's WebCrypto does the signing.
//
// Keys live in data/push/vapid.json (generated once). Browser subscriptions
// live in data/push/subscriptions.json and are pruned automatically when the
// push service reports them gone (404/410).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { webcrypto } from "node:crypto";
import { PATHS } from "./config.ts";

type JsonWebKey = webcrypto.JsonWebKey;

const dir = () => join(PATHS.data, "push");
const vapidPath = () => join(dir(), "vapid.json");
const subsPath = () => join(dir(), "subscriptions.json");

// mailto:/https: subject the push service uses to contact us about abuse.
const SUBJECT =
  process.env.LFG_VAPID_SUBJECT ||
  `mailto:${process.env.LFG_VAPID_EMAIL || "itechbenny@gmail.com"}`;

export type PushSubscription = {
  endpoint: string;
  keys?: { p256dh?: string; auth?: string };
  user?: string | null;
  // Payload-less pushes still need to identify event-specific notifications.
  // Queue those server-side per subscription; the service worker consumes one
  // after each wake through /api/push/pending.
  pendingNotifications?: PushNotification[];
};

export type PushNotification = {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
};

type VapidFile = {
  privateJwk: JsonWebKey;
  publicKeyB64Url: string;
  subject: string;
};

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function ensureDir() {
  await mkdir(dir(), { recursive: true });
}

// ---------- VAPID keypair (generate once, then persist) ----------

let cached: VapidFile | null = null;

async function vapid(): Promise<VapidFile> {
  if (cached) return cached;
  const f = Bun.file(vapidPath());
  if (await f.exists()) {
    cached = JSON.parse(await f.text()) as VapidFile;
    return cached;
  }
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey); // 65-byte uncompressed point
  const next: VapidFile = { privateJwk, publicKeyB64Url: b64url(raw), subject: SUBJECT };
  cached = next;
  await ensureDir();
  await Bun.write(vapidPath(), JSON.stringify(next, null, 2));
  return next;
}

/** The application server public key the browser passes to pushManager.subscribe(). */
export async function vapidPublicKey(): Promise<string> {
  return (await vapid()).publicKeyB64Url;
}

async function signJwt(aud: string): Promise<string> {
  const v = await vapid();
  const key = await crypto.subtle.importKey(
    "jwk",
    v.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: v.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  ); // raw r||s (IEEE P1363) — exactly what JWS ES256 wants
  return `${signingInput}.${b64url(sig)}`;
}

// ---------- subscription store ----------

export async function listSubscriptions(): Promise<PushSubscription[]> {
  const f = Bun.file(subsPath());
  if (!(await f.exists())) return [];
  try {
    return JSON.parse(await f.text()) as PushSubscription[];
  } catch {
    return [];
  }
}

async function writeSubscriptions(rows: PushSubscription[]): Promise<void> {
  await ensureDir();
  await Bun.write(subsPath(), JSON.stringify(rows, null, 2));
}

export async function saveSubscription(sub: PushSubscription): Promise<void> {
  if (!sub?.endpoint) return;
  const rows = await listSubscriptions();
  const existing = rows.find((r) => r.endpoint === sub.endpoint);
  const next = rows.filter((r) => r.endpoint !== sub.endpoint);
  next.push({
    endpoint: sub.endpoint,
    keys: sub.keys,
    user: sub.user ?? null,
    pendingNotifications: existing?.pendingNotifications,
  });
  await writeSubscriptions(next);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const rows = await listSubscriptions();
  await writeSubscriptions(rows.filter((r) => r.endpoint !== endpoint));
}

/** Which user a given device (subscription endpoint) belongs to, if known. */
export async function subscriptionUser(endpoint: string): Promise<string | null> {
  const rows = await listSubscriptions();
  return rows.find((r) => r.endpoint === endpoint)?.user ?? null;
}

const MAX_PENDING_NOTIFICATIONS = 20;

/** Queue an event-specific notification for the subscriptions this push targets. */
export async function queuePushNotification(
  notification: PushNotification,
  opts: { user?: string | null } = {},
): Promise<void> {
  const rows = await listSubscriptions();
  let changed = false;
  const next = rows.map((row) => {
    if (opts.user && row.user !== opts.user) return row;
    changed = true;
    return {
      ...row,
      pendingNotifications: [...(row.pendingNotifications ?? []), notification].slice(
        -MAX_PENDING_NOTIFICATIONS,
      ),
    };
  });
  if (changed) await writeSubscriptions(next);
}

/** Consume the oldest event-specific notification queued for one device. */
export async function takePushNotification(endpoint: string): Promise<PushNotification | null> {
  const rows = await listSubscriptions();
  const index = rows.findIndex((row) => row.endpoint === endpoint);
  const pending = index >= 0 ? rows[index].pendingNotifications ?? [] : [];
  const notification = pending[0];
  if (!notification) return null;
  const next = [...rows];
  next[index] = {
    ...next[index],
    pendingNotifications: pending.length > 1 ? pending.slice(1) : undefined,
  };
  await writeSubscriptions(next);
  return notification;
}

// ---------- sending ----------

async function sendOne(sub: PushSubscription): Promise<{ gone: boolean }> {
  const aud = new URL(sub.endpoint).origin;
  const jwt = await signJwt(aud);
  const pub = await vapidPublicKey();
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${pub}`,
      TTL: "120",
      Urgency: "high",
      "Content-Length": "0",
    },
  });
  // 404/410 = subscription expired/unsubscribed → caller prunes it.
  return { gone: res.status === 404 || res.status === 410 };
}

/**
 * Fan a payload-less push out to every subscription (optionally only those
 * tagged to a given user). Prunes dead subscriptions. Never throws — push is
 * best-effort and must not block the caller (a finding write).
 */
export async function notifyAll(
  opts: { user?: string | null; notification?: PushNotification } = {},
): Promise<void> {
  let rows = await listSubscriptions();
  // Targeted notification → ONLY devices bound to that user. A device with no
  // bound user does NOT catch another user's pushes (that was the leak).
  if (opts.user) rows = rows.filter((r) => r.user === opts.user);
  if (!rows.length) return;
  if (opts.notification) {
    await queuePushNotification(opts.notification, { user: opts.user });
  }
  const dead: string[] = [];
  await Promise.all(
    rows.map(async (sub) => {
      try {
        const { gone } = await sendOne(sub);
        if (gone) dead.push(sub.endpoint);
      } catch {
        // transient network error to one push service — ignore, try next time
      }
    }),
  );
  if (dead.length) {
    const keep = (await listSubscriptions()).filter((r) => !dead.includes(r.endpoint));
    await writeSubscriptions(keep);
  }
}
