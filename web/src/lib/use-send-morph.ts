import * as React from "react";

/**
 * FLIP send-morph: a just-sent user turn launches from the composer's ACTUAL
 * on-screen position instead of a fixed offset.
 *
 * The CSS-only predecessor (.lfg-user-send) hardcoded translateY(10px), which
 * only looked right when the composer happened to be one line tall and parked
 * at the bottom. The real gap between composer and landed bubble moves
 * constantly — soft keyboard, attachment chips, a multi-line prompt, a short
 * transcript that isn't bottom-anchored — so the launch point was usually wrong.
 * Measuring both rects at mount fixes that for free.
 *
 * Deliberately translate + uniform scale only, never a rect-matching
 * scaleX/scaleY: the bubble contains text, and non-uniform scale visibly
 * squashes glyphs. Sticking to compositor-friendly transform/opacity also keeps
 * this consistent with the rest of the transcript's motion (lfg-msg-in,
 * lfg-tool-row-in), which never animates layout properties.
 */

const DURATION_MS = 320;
// The house iOS curve (matches --ease-ios); WAAPI can't read the CSS var.
const EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
// A long transcript can put the composer far from where the bubble lands.
// Past a point the "launch" reads as a slow fly-in, so cap the travel and let
// it become a local pop instead.
const MAX_TRAVEL_PX = 180;

const clamp = (v: number) =>
  Math.max(-MAX_TRAVEL_PX, Math.min(MAX_TRAVEL_PX, v));

export function useSendMorph<T extends HTMLElement>(active: boolean) {
  const ref = React.useRef<T>(null);
  // One-shot: a re-render while the send is still pending must not replay it.
  const played = React.useRef(false);

  React.useLayoutEffect(() => {
    if (!active || played.current) return;
    const el = ref.current;
    if (!el) return;
    played.current = true;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof el.animate !== "function") return;

    // Scope to this session's column so a multi-column fleet view measures its
    // own composer rather than whichever one happens to be first in the DOM.
    const scope: ParentNode = el.closest("[data-stage-sid]") ?? document;
    const composer = scope.querySelector<HTMLElement>("[data-composer-sid]");
    if (!composer) return;

    const from = composer.getBoundingClientRect();
    const to = el.getBoundingClientRect();
    // A collapsed/offscreen row has nothing meaningful to animate toward.
    if (!to.width || !to.height || !from.width) return;

    // Anchor bottom-right: user bubbles hug the right edge, so that corner is
    // the one that visually stays put as the turn settles.
    const dx = clamp(from.right - to.right);
    const dy = clamp(from.bottom - to.bottom);
    if (!dx && !dy) return;

    const previousOrigin = el.style.transformOrigin;
    el.style.transformOrigin = "100% 100%";

    const anim = el.animate(
      [
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.975)` },
        { opacity: 1, transform: "translate(0, 0) scale(1)" },
      ],
      { duration: DURATION_MS, easing: EASING, fill: "both" },
    );

    const cleanup = () => {
      // fill:"both" would otherwise pin the final frame onto the element and
      // keep it out of the normal style cascade for the rest of its life.
      anim.cancel();
      el.style.transformOrigin = previousOrigin;
    };
    anim.finished.then(cleanup).catch(() => {});

    return () => {
      anim.cancel();
      el.style.transformOrigin = previousOrigin;
    };
  }, [active]);

  return ref;
}
