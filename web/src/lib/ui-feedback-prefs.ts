import { useSyncExternalStore } from "react";

// Shared on/off preferences for UI sound effects and haptics. Kept in its own
// leaf module (no imports from haptics/sfx/feedback) so both the haptic
// primitive and the sound layer can gate on it without a circular import.
//
// Persisted to localStorage and cached in-memory; a tiny subscriber list lets
// the settings UI re-render live and keeps multiple tabs / components in sync.

export type UiFeedbackPrefs = {
  sound: boolean;
  haptics: boolean;
};

const STORAGE_KEY = "lfg_ui_feedback";
const DEFAULTS: UiFeedbackPrefs = { sound: true, haptics: true };

let cache: UiFeedbackPrefs | null = null;
const listeners = new Set<(prefs: UiFeedbackPrefs) => void>();

function read(): UiFeedbackPrefs {
  if (typeof window === "undefined") return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<UiFeedbackPrefs>;
    return {
      sound: parsed.sound ?? DEFAULTS.sound,
      haptics: parsed.haptics ?? DEFAULTS.haptics,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getUiFeedbackPrefs(): UiFeedbackPrefs {
  if (!cache) cache = read();
  return cache;
}

export function setUiFeedbackPrefs(patch: Partial<UiFeedbackPrefs>): void {
  const next = { ...getUiFeedbackPrefs(), ...patch };
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  for (const listener of listeners) listener(next);
}

export function subscribeUiFeedbackPrefs(
  listener: (prefs: UiFeedbackPrefs) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// React binding for the settings UI. getUiFeedbackPrefs returns the cached
// object (stable identity between changes), so useSyncExternalStore won't loop.
export function useUiFeedbackPrefs(): UiFeedbackPrefs {
  return useSyncExternalStore(
    subscribeUiFeedbackPrefs,
    getUiFeedbackPrefs,
    getUiFeedbackPrefs,
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
