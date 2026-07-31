/**
 * Resolve a session's optional presentation owner from the current LFG roster.
 *
 * The browser remembers the last selected email in localStorage, but that value
 * can outlive a Computer, a roster change, or an omg account email change. It
 * is never an authentication claim. Only send it back when the current server
 * roster still contains it; a roster-less hosted Computer leaves sessions
 * unassigned and relies on the host's stable account-id authorization instead.
 */
export function resolveRosterUser(
  requested: string | null | undefined,
  users: ReadonlyArray<{ email: string }>,
): string {
  if (requested !== null && requested !== undefined) {
    const wanted = requested.trim();
    if (!wanted) return "";
    if (users.some((user) => user.email === wanted)) return wanted;
  }
  return users[0]?.email ?? "";
}
