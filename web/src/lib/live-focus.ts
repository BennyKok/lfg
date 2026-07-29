export type LiveFocusRequest = {
  sid: string;
  n: number;
};

export type PendingLiveFocus = {
  sid: string;
  token: string;
};

export function pendingLiveFocusRequest(
  focus: LiveFocusRequest | null | undefined,
  handledToken: string | null,
  availableSessionIds: { has(sessionId: string): boolean },
): PendingLiveFocus | null {
  if (!focus) return null;
  const token = `${focus.sid}:${focus.n}`;
  if (token === handledToken || !availableSessionIds.has(focus.sid)) return null;
  return { sid: focus.sid, token };
}
