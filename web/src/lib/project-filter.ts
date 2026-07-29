export const PROJECT_FILTER_STORAGE_KEY = "lfg_v2_project_filter";

type ProjectFilterStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): ProjectFilterStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readCachedProjectFilter(
  storage: ProjectFilterStorage | null = browserStorage(),
): string {
  try {
    return storage?.getItem(PROJECT_FILTER_STORAGE_KEY) || "__all";
  } catch {
    return "__all";
  }
}

export function cacheProjectFilter(
  projectFilter: string,
  storage: ProjectFilterStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(PROJECT_FILTER_STORAGE_KEY, projectFilter);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // current page still keeps the selection in React state.
  }
}
