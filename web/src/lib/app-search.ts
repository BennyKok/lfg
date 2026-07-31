// The typed URL contract for the app, shared by the router (which validates it)
// and App.tsx (which reads/writes it). Kept in its own module so neither has to
// import the other — router.tsx imports <App>, so App.tsx pulling the schema
// from router.tsx would be a cycle.
//
// Routing is PATH-based: the visible page is the first path segment
// (`/settings`, `/usage`, `/my-extension-tab`), with `/` meaning the default
// ("live"). Search params: `session` (deep-link contract) and `embed` (framed
// host mode). A legacy `?tab=` param is still accepted on `/` and redirected to
// the matching path so old links/bookmarks keep working.

/** The built-in top-level pages. NOT exhaustive: runtime extensions register
 *  their own nav tabs with arbitrary ids (see useExtensionNavTabs), so a tab is
 *  typed as `string`, not this union. These values document the known set. */
export const TAB_VALUES = [
  "live",
  "notifications",
  "artifacts",
  "settings",
  "auto",
  "usage",
  "coding-agents",
  "changelog",
  "term",
  "browser",
] as const;
export type Tab = (typeof TAB_VALUES)[number];
export const DEFAULT_TAB: Tab = "live";

/** The visible page for a pathname — the first path segment, or the default
 *  ("live") at the root. An id matching no built-in page and no extension tab
 *  renders the Settings page (the app's existing catch-all). */
export function pathnameToTab(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean)[0];
  const tab = seg ? decodeURIComponent(seg) : DEFAULT_TAB;
  // `/shipped` was the original public route, and `/ask` was a separate page
  // for agent questions before they became notifications. Both fold into the
  // canonical Notification Center; keep old links and bookmarks working.
  return tab === "shipped" || tab === "ask" ? "notifications" : tab;
}

/** The URL path for a tab. The default tab lives at `/` (kept segment-free so
 *  the common link stays clean); every other tab is a single path segment. */
export function tabToPath(tab: string): string {
  const canonical = tab === "shipped" || tab === "ask" ? "notifications" : tab;
  return canonical === DEFAULT_TAB ? "/" : `/${encodeURIComponent(canonical)}`;
}

/** Same-tab requests are state updates, not route changes. Avoiding a redundant
 * navigation also preserves active search contracts such as `session` and
 * `embed`, which the router would otherwise clear when no `search` is supplied. */
export function shouldNavigateToTab(currentTab: string, nextTab: string): boolean {
  return currentTab !== nextTab;
}

/** Read the session contract from the browser URL before router search state is
 * hydrated. The location is the boot-time source of truth for external links;
 * callers may pass a search string to test the parser without a browser. */
export function readLocationSessionId(search?: string): string | null {
  try {
    const raw =
      search ??
      (typeof window !== "undefined" ? window.location.search : "");
    const session = new URLSearchParams(raw).get("session");
    return session || null;
  } catch {
    return null;
  }
}

/** The typed shape of the app's search params (path aside). */
export interface AppSearch {
  /** Deep link to focus a session on load. EXTERNAL CONTRACT: the server emits
   *  `/?session=<id>` via `publicSessionUrl` into messaging bridges and Shipped
   *  posts, so this key must never be renamed or dropped. */
  session?: string;
  /** Framed-host mode (omg Computer iframe). EXTERNAL CONTRACT with omg's
   *  use-computer-session-frame mint — must stay as `embed=1`. */
  embed?: boolean;
  /** Optional absolute origin of the embedding host, for hosts whose
   *  Referrer-Policy strips the referrer. Kept in the typed contract so the
   *  router's own `?embed=1` → `?embed=true` rewrite doesn't drop it. Consumed
   *  by lib/embed-host-signal.ts, which validates the scheme. */
  embedOrigin?: string;
}

/** Validate the search params carried on every route. */
export function validateAppSearch(search: Record<string, unknown>): AppSearch {
  const out: AppSearch = {};
  if (typeof search.session === "string" && search.session) out.session = search.session;
  if (
    search.embed === true ||
    search.embed === 1 ||
    search.embed === "1" ||
    search.embed === "true"
  ) {
    out.embed = true;
  }
  if (typeof search.embedOrigin === "string" && search.embedOrigin) {
    out.embedOrigin = search.embedOrigin;
  }
  return out;
}

/** The index (`/`) route additionally tolerates a legacy `?tab=` param so old
 *  links redirect to the matching path. */
export interface IndexSearch extends AppSearch {
  tab?: string;
}

export function validateIndexSearch(search: Record<string, unknown>): IndexSearch {
  const out: IndexSearch = validateAppSearch(search);
  if (typeof search.tab === "string" && search.tab && search.tab !== DEFAULT_TAB) {
    out.tab = search.tab;
  }
  return out;
}

/** Whether routing should prioritize focusing a live session over other shell
 *  work (filters, identity gate, secondary tab warmups). True when a session
 *  deep-link is present. */
export function shouldPrioritizeSession(search: AppSearch | null | undefined): boolean {
  return typeof search?.session === "string" && search.session.length > 0;
}
