// The typed URL contract for the app, shared by the router (which validates it)
// and App.tsx (which reads/writes it). Kept in its own module so neither has to
// import the other — router.tsx imports <App>, so App.tsx pulling the schema
// from router.tsx would be a cycle.
//
// Routing is PATH-based: the visible page is the first path segment
// (`/settings`, `/usage`, `/my-extension-tab`), with `/` meaning the default
// ("live"). The only search param is `session` — an external deep-link contract
// (see below). A legacy `?tab=` param is still accepted on `/` and redirected to
// the matching path so old links/bookmarks keep working.

/** The built-in top-level pages. NOT exhaustive: runtime extensions register
 *  their own nav tabs with arbitrary ids (see useExtensionNavTabs), so a tab is
 *  typed as `string`, not this union. These values document the known set. */
export const TAB_VALUES = [
  "live",
  "shipped",
  "artifacts",
  "settings",
  "ask",
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
  return seg ? decodeURIComponent(seg) : DEFAULT_TAB;
}

/** The URL path for a tab. The default tab lives at `/` (kept segment-free so
 *  the common link stays clean); every other tab is a single path segment. */
export function tabToPath(tab: string): string {
  return tab === DEFAULT_TAB ? "/" : `/${encodeURIComponent(tab)}`;
}

/** The typed shape of the app's search params (path aside). */
export interface AppSearch {
  /** Deep link to focus a session on load. EXTERNAL CONTRACT: the server emits
   *  `/?session=<id>` via `publicSessionUrl` into messaging bridges and Shipped
   *  posts, so this key must never be renamed or dropped. */
  session?: string;
}

/** Validate the search params carried on every route. */
export function validateAppSearch(search: Record<string, unknown>): AppSearch {
  const out: AppSearch = {};
  if (typeof search.session === "string" && search.session) out.session = search.session;
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
