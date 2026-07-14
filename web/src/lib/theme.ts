export const THEME_STORAGE_KEY = "lfg_theme";
export const THEME_CHANGE_EVENT = "lfg-theme-change";

export type ThemePreference = "light" | "dark";

export function getThemePreference(): ThemePreference | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function applyTheme(forcedDark?: boolean): boolean {
  const preference = getThemePreference();
  const dark =
    forcedDark ??
    (preference
      ? preference === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("light", !dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", dark ? "#000000" : "#f2f2f7");
  return dark;
}

export function setThemePreference(dark: boolean): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // current page should still apply the selection immediately.
  }
  applyTheme(dark);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}
