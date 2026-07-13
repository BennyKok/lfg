import { WebHaptics, type HapticInput } from "web-haptics";
import { getUiFeedbackPrefs } from "./ui-feedback-prefs";

/**
 * Imperative haptic singleton for use in shared UI components.
 *
 * Silently no-ops on unsupported platforms (desktop browsers, SSR) and when the
 * user has turned haptics off in settings.
 */
let instance: WebHaptics | null = null;

function getInstance(): WebHaptics {
  if (!instance) {
    instance = new WebHaptics();
  }
  return instance;
}

export function haptic(type?: HapticInput) {
  if (!getUiFeedbackPrefs().haptics) return;
  getInstance().trigger(type);
}
