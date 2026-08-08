// iOS Safari zooms the whole viewport whenever a focused text field renders
// below 16px. index.css already pins every input/textarea to 16px under
// `(pointer: coarse)` — but a stylesheet in the document cannot cross a shadow
// boundary, and both Pierre surfaces in the Files panel keep their real field
// inside one (the tree's search box, the editor's input). Tapping either one on
// a phone therefore zoomed the page and left the panel scrolled off-screen,
// because <html> is sized from --lfg-app-height and never scrolls back.
//
// So push an equivalent rule through the boundary: walk the container for shadow
// hosts and adopt a tiny stylesheet into each shadow root. Coarse pointers only,
// so desktop rendering is untouched.

const RULE = `input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="color"]),
textarea,
[contenteditable]:not([contenteditable="false"]) {
  font-size: 16px !important;
}`;

const MARKER = "data-omg-touch-text-size";

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
}

function adopt(root: ShadowRoot): void {
  // A duplicate <style> per re-scan would grow without bound; the marker makes
  // the walk idempotent.
  if (root.querySelector(`style[${MARKER}]`)) return;
  const style = document.createElement("style");
  style.setAttribute(MARKER, "");
  style.textContent = RULE;
  root.appendChild(style);
}

function walk(node: ParentNode, onRoot: (root: ShadowRoot) => void, depth = 0): void {
  // Pierre nests at most a couple of levels; the cap is a cheap guard against a
  // pathological tree rather than a real limit.
  if (depth > 4) return;
  for (const el of node.querySelectorAll("*")) {
    const shadow = (el as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
    if (!shadow) continue;
    adopt(shadow);
    onRoot(shadow);
    walk(shadow, onRoot, depth + 1);
  }
}

/**
 * Keeps every text field inside `container`'s shadow roots at 16px on touch
 * devices. The shadow root is attached asynchronously (and re-populated as the
 * component renders), so re-scan on mutation until the caller disposes.
 *
 * Returns a cleanup function; safe to call with a null container.
 */
export function pinShadowTextSizeForTouch(container: Element | null): () => void {
  if (!container || !isCoarsePointer()) return () => {};

  let frame = 0;
  const observer = new MutationObserver(() => schedule());
  const observed = new WeakSet<ShadowRoot>();
  // A MutationObserver on the light DOM never sees inside a shadow root, so each
  // root we find gets its own — that is what catches a nested host (or a search
  // box) rendered a frame after the root was attached.
  const observeRoot = (root: ShadowRoot) => {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, { childList: true, subtree: true });
  };
  const scan = () => {
    frame = 0;
    walk(container, observeRoot);
  };
  // Coalesce bursts of mutations (the tree repaints every row on a search
  // keystroke) into one walk per frame.
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(scan);
  };

  scan();
  observer.observe(container, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
