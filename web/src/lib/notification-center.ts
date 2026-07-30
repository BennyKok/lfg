export type NotificationReadState = {
  through: number;
  ids: string[];
};

export const NOTIFICATION_READ_STATE_EVENT = "lfg-notification-read-state";

const KEY_PREFIX = "lfg_notification_reads_v1:";
const MAX_INDIVIDUAL_READ_IDS = 500;

function storageKey(identity?: string | null): string {
  return `${KEY_PREFIX}${identity?.trim().toLowerCase() || "__device__"}`;
}

function normalize(value: unknown): NotificationReadState | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { through?: unknown; ids?: unknown };
  const through =
    typeof row.through === "number" && Number.isFinite(row.through)
      ? Math.max(0, row.through)
      : 0;
  const ids = Array.isArray(row.ids)
    ? row.ids
        .filter((id): id is string => typeof id === "string")
        .slice(-MAX_INDIVIDUAL_READ_IDS)
    : [];
  return { through, ids: [...new Set(ids)] };
}

export function notificationReadState(
  identity?: string | null,
): NotificationReadState | null {
  if (typeof window === "undefined") return null;
  try {
    return normalize(JSON.parse(localStorage.getItem(storageKey(identity)) ?? "null"));
  } catch {
    return null;
  }
}

function writeNotificationReadState(
  identity: string | null | undefined,
  state: NotificationReadState,
): NotificationReadState {
  if (typeof window === "undefined") return state;
  localStorage.setItem(storageKey(identity), JSON.stringify(state));
  window.dispatchEvent(
    new CustomEvent(NOTIFICATION_READ_STATE_EVENT, {
      detail: { identity: identity?.trim().toLowerCase() || "__device__" },
    }),
  );
  return state;
}

export function shippedNotificationId(post: { id: string; rev: number }): string {
  return `shipped:${post.id}:${post.rev}`;
}

export function notificationIsUnread(
  state: NotificationReadState | null,
  notification: { id: string; ts: number },
): boolean {
  if (!state) return false;
  return notification.ts > state.through && !state.ids.includes(notification.id);
}

/** Mark one notification read without swallowing newer or unrelated items. */
export function markNotificationRead(
  identity: string | null | undefined,
  notificationId: string,
): NotificationReadState {
  const current = notificationReadState(identity) ?? { through: 0, ids: [] };
  if (current.ids.includes(notificationId)) return current;
  return writeNotificationReadState(identity, {
    ...current,
    ids: [...current.ids, notificationId].slice(-MAX_INDIVIDUAL_READ_IDS),
  });
}

/**
 * Advance the chronological read cursor. Individual ids at or below the cursor
 * can be discarded; newer ids stay read if a person opened them out of order.
 */
export function markAllNotificationsRead(
  identity: string | null | undefined,
  through: number,
): NotificationReadState {
  const current = notificationReadState(identity) ?? { through: 0, ids: [] };
  return writeNotificationReadState(identity, {
    through: Math.max(current.through, through),
    ids: current.ids,
  });
}
