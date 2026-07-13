// One call site for "this interaction happened" → play the matching sound and
// haptic together, each gated by the user's preference. Components should call
// these semantic helpers (feedback.tap(), feedback.send(), …) rather than
// reaching for playSfx/haptic directly, so sound + haptic stay in lockstep and
// the vocabulary is consistent across the app.

import type { HapticInput } from "web-haptics";
import { haptic } from "./haptics"; // self-gates on the haptics preference
import { playSfx, type SfxName } from "./sfx";
import { getUiFeedbackPrefs } from "./ui-feedback-prefs";

function fire(sfx: SfxName | null, hap: HapticInput | null) {
  if (sfx && getUiFeedbackPrefs().sound) playSfx(sfx);
  if (hap != null) haptic(hap);
}

export const feedback = {
  /** Generic button / control press. */
  tap: () => fire("tap", "light"),
  /** Choosing an item in a menu / list / segmented control. */
  select: () => fire("select", "selection"),
  /** Flipping a switch or checkbox. */
  toggle: (on: boolean) => fire(on ? "toggleOn" : "toggleOff", on ? "medium" : "light"),
  /** Submitting the composer / sending a message. */
  send: () => fire("send", "medium"),
  /** A positive outcome (session created, saved, copied). */
  success: () => fire("success", "success"),
  /** A failure / rejected action. */
  error: () => fire("error", "error"),
  /** Stepping through options via swipe/scroll. */
  swipe: () => fire("swipe", "selection"),
  /** A surface opening (dialog, popover, sheet). */
  open: () => fire("open", "light"),
  /** A surface closing. */
  close: () => fire("close", null),
  /** Passive inbound event (assistant reply / turn finished). */
  receive: () => fire("receive", null),
} as const;

export type Feedback = typeof feedback;
