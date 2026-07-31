import { useSyncExternalStore } from "react";

// Display preferences for the Projects picker sheet.
//
// `showPaths` controls whether each row renders its full working directory
// under the project name. Hiding it halves the row height, so roughly twice as
// many projects fit in the sheet without scrolling — which is the default,
// since the folder name is usually enough to pick from. Persisted so the
// choice survives reloads, and shared through a tiny subscriber list so every
// mounted copy of the sheet (rail + new-session dialog) flips together.

export type ProjectListPrefs = {
  showPaths: boolean;
};

const STORAGE_KEY = "lfg_project_list";
const DEFAULTS: ProjectListPrefs = { showPaths: false };

let cache: ProjectListPrefs | null = null;
const listeners = new Set<(prefs: ProjectListPrefs) => void>();

function read(): ProjectListPrefs {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ProjectListPrefs>;
    return { showPaths: parsed.showPaths ?? DEFAULTS.showPaths };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getProjectListPrefs(): ProjectListPrefs {
  if (!cache) cache = read();
  return cache;
}

export function setProjectListPrefs(patch: Partial<ProjectListPrefs>): void {
  const next = { ...getProjectListPrefs(), ...patch };
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  for (const listener of listeners) listener(next);
}

export function subscribeProjectListPrefs(
  listener: (prefs: ProjectListPrefs) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// getProjectListPrefs returns the cached object (stable identity between
// writes), so useSyncExternalStore won't re-render in a loop.
export function useProjectListPrefs(): ProjectListPrefs {
  return useSyncExternalStore(
    subscribeProjectListPrefs,
    getProjectListPrefs,
    getProjectListPrefs,
  );
}

// Keep tabs in sync when the key is written elsewhere.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cache = read();
    for (const listener of listeners) listener(cache);
  });
}
