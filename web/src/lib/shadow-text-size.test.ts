/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { pinShadowTextSizeForTouch } from "./shadow-text-size";

// The bug this guards against: iOS Safari zooms the whole viewport when a
// focused text field renders below 16px, and index.css pins every input to 16px
// under (pointer: coarse) — but a document stylesheet stops at a shadow
// boundary. Both Pierre surfaces in the Files panel keep their real field inside
// one at 13px, so tapping the tree's search box or the editor zoomed the page
// into the sheet with no way back out.

let window: Window;

beforeEach(() => {
  window = new Window();
  globalThis.document = window.document as unknown as Document;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id as unknown as Timer)) as typeof cancelAnimationFrame;
  globalThis.MutationObserver = window.MutationObserver as unknown as typeof MutationObserver;
  setPointer("coarse");
});

afterEach(() => {
  window.close();
});

function setPointer(kind: "coarse" | "fine") {
  globalThis.window = {
    matchMedia: (query: string) => ({ matches: query.includes("coarse") && kind === "coarse" }),
  } as unknown as typeof globalThis.window;
}

function hostWithShadow(container: Element, tag: string): ShadowRoot {
  const host = window.document.createElement(tag);
  container.appendChild(host);
  return host.attachShadow({ mode: "open" }) as unknown as ShadowRoot;
}

function injectedRules(root: ShadowRoot): string {
  return [...root.querySelectorAll("style[data-omg-touch-text-size]")]
    .map((s) => s.textContent ?? "")
    .join("\n");
}

describe("pinShadowTextSizeForTouch", () => {
  test("pushes a 16px rule through the shadow boundary on touch", () => {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const shadow = hostWithShadow(container as unknown as Element, "file-tree-container");

    pinShadowTextSizeForTouch(container as unknown as Element);

    expect(injectedRules(shadow)).toContain("font-size: 16px !important");
    expect(injectedRules(shadow)).toContain("textarea");
    expect(injectedRules(shadow)).toContain("contenteditable");
  });

  test("reaches a nested shadow root too", () => {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const outer = hostWithShadow(container as unknown as Element, "diffs-container");
    const inner = hostWithShadow(outer as unknown as Element, "diffs-editor");

    pinShadowTextSizeForTouch(container as unknown as Element);

    expect(injectedRules(inner)).toContain("font-size: 16px !important");
  });

  test("does nothing on a fine pointer, so desktop rendering is untouched", () => {
    setPointer("fine");
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const shadow = hostWithShadow(container as unknown as Element, "file-tree-container");

    pinShadowTextSizeForTouch(container as unknown as Element);

    expect(injectedRules(shadow)).toBe("");
  });

  test("re-scanning does not stack duplicate stylesheets", () => {
    const container = window.document.createElement("div");
    window.document.body.appendChild(container);
    const shadow = hostWithShadow(container as unknown as Element, "file-tree-container");

    pinShadowTextSizeForTouch(container as unknown as Element);
    pinShadowTextSizeForTouch(container as unknown as Element);

    expect(shadow.querySelectorAll("style[data-omg-touch-text-size]").length).toBe(1);
  });

  test("a null container is a no-op rather than a throw", () => {
    expect(() => pinShadowTextSizeForTouch(null)()).not.toThrow();
  });
});
