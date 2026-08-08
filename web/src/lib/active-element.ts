// Focus helpers that see through shadow DOM.
//
// `document.activeElement` stops at the shadow HOST. For a component that
// renders its real input inside a shadow root — Pierre's file tree
// (`FILE-TREE-CONTAINER > INPUT`) and code editor (`DIFFS-CONTAINER > DIV[ce]`)
// both do — the host is a plain custom element, so a naive
// `tagName === "INPUT" || isContentEditable` guard reports "not typing" and the
// app's global hotkeys fire on every keystroke the user types. In practice that
// meant typing in the file tree's search box or the editor would open dialogs
// and jump between sessions mid-word.

/** The deepest focused element, descending through any nested shadow roots. */
export function deepActiveElement(): HTMLElement | null {
  let el = document.activeElement as HTMLElement | null;
  while (el?.shadowRoot?.activeElement) {
    el = el.shadowRoot.activeElement as HTMLElement;
  }
  return el;
}

/**
 * True when focus is in a surface that consumes raw typing, so a global
 * single-key shortcut must stand down. Pass an element to test a known target,
 * or omit it to test whatever currently has focus (shadow DOM included).
 */
export function isTypingTarget(el: Element | null = deepActiveElement()): boolean {
  if (!el) return false;
  const tag = el.tagName;
  // IFRAME counts: focus may sit in embedded content we cannot inspect.
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "IFRAME") return true;
  return (el as HTMLElement).isContentEditable === true;
}
