import { WebHaptics, type HapticInput } from "web-haptics";
import { getUiFeedbackPrefs } from "./ui-feedback-prefs";

/**
 * Imperative haptic singleton for use in shared UI components.
 *
 * Silently no-ops on unsupported platforms (desktop browsers, SSR) and when the
 * user has turned haptics off in settings.
 *
 * Platform paths:
 * - Android / anything with `navigator.vibrate` → web-haptics Vibration API.
 * - iOS Safari / PWA → WebKit only fires Taptic Engine for native
 *   `<input type="checkbox" switch>` toggles. web-haptics injects that switch
 *   but defaults to `display: none`, which Safari does NOT treat as a real
 *   switch flip — so we keep our own off-screen (opacity/clip, not display:none)
 *   switch and click it ourselves.
 */

let instance: WebHaptics | null = null;
let iosSwitch: HTMLInputElement | null = null;
let iosRaf: number | null = null;

function hasVibrateApi(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

function getInstance(): WebHaptics {
  if (!instance) {
    instance = new WebHaptics();
  }
  return instance;
}

/** Keep the switch in the layout/accessibility tree so WebKit's Taptic path runs. */
function ensureIosSwitch(): HTMLInputElement | null {
  if (typeof document === "undefined") return null;
  if (iosSwitch?.isConnected) return iosSwitch;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("switch", "");
  input.setAttribute("aria-hidden", "true");
  input.tabIndex = -1;
  // 1×1, near-invisible, but NOT display:none / visibility:hidden — those
  // suppress the iOS switch haptic that web-haptics relies on.
  Object.assign(input.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "1px",
    height: "1px",
    margin: "0",
    padding: "0",
    opacity: "0.01",
    pointerEvents: "none",
    border: "0",
    clipPath: "inset(50%)",
    zIndex: "-1",
  });
  document.body.appendChild(input);
  iosSwitch = input;
  return input;
}

function tickIosSwitch(): void {
  const input = ensureIosSwitch();
  if (!input) return;
  // .click() is what WebKit associates with the system switch haptic.
  input.click();
}

/** Rough multi-tick patterns for presets on iOS (each tick is one switch flip). */
function iosTickCount(type?: HapticInput): number {
  if (type == null || typeof type === "number" || Array.isArray(type)) return 1;
  if (typeof type === "object") return Math.min(3, Math.max(1, type.pattern?.length ?? 1));
  switch (type) {
    case "success":
    case "nudge":
      return 2;
    case "error":
    case "warning":
      return 3;
    case "buzz":
      return 4;
    default:
      return 1;
  }
}

function triggerIos(type?: HapticInput): void {
  const count = iosTickCount(type);
  tickIosSwitch();
  if (count <= 1) return;

  if (iosRaf != null) cancelAnimationFrame(iosRaf);
  let n = 1;
  let last = performance.now();
  const gapMs = type === "error" ? 50 : 70;
  const step = (now: number) => {
    if (now - last >= gapMs) {
      tickIosSwitch();
      last = now;
      n += 1;
      if (n >= count) {
        iosRaf = null;
        return;
      }
    }
    iosRaf = requestAnimationFrame(step);
  };
  iosRaf = requestAnimationFrame(step);
}

export function haptic(type?: HapticInput) {
  if (!getUiFeedbackPrefs().haptics) return;

  // iOS (and anything without Vibration API): dedicated switch path.
  if (!hasVibrateApi()) {
    triggerIos(type);
    return;
  }

  // Android / desktop-with-vibrate: library patterns via navigator.vibrate.
  void getInstance().trigger(type);
}
