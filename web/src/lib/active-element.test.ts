/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { deepActiveElement, isTypingTarget } from "./active-element";

// The bug this guards against: Pierre's file tree and code editor both render
// their real input INSIDE a shadow root, so `document.activeElement` reports the
// custom-element host. Every global hotkey guard in the app then concluded the
// user was not typing and fired shortcuts on each keystroke — typing in the tree
// search or the editor opened dialogs and jumped between sessions mid-word.

let window: Window;

beforeEach(() => {
  window = new Window();
  globalThis.document = window.document as unknown as Document;
});

afterEach(() => {
  window.close();
});

function hostWith(inner: string): HTMLElement {
  const host = window.document.createElement("diffs-container");
  window.document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = inner;
  return host as unknown as HTMLElement;
}

describe("deepActiveElement", () => {
  test("descends into a shadow root instead of stopping at the host", () => {
    const host = hostWith(`<input type="text" id="inner" />`);
    const inner = host.shadowRoot!.querySelector("input") as unknown as HTMLElement;
    inner.focus();

    expect((window.document.activeElement as unknown as HTMLElement).tagName).toBe("DIFFS-CONTAINER");
    expect(deepActiveElement()?.tagName).toBe("INPUT");
  });

  test("returns the plain focused element when no shadow root is involved", () => {
    const input = window.document.createElement("textarea");
    window.document.body.appendChild(input);
    (input as unknown as HTMLElement).focus();

    expect(deepActiveElement()?.tagName).toBe("TEXTAREA");
  });
});

describe("isTypingTarget", () => {
  test("recognises an input focused inside a shadow root", () => {
    const host = hostWith(`<input type="text" />`);
    (host.shadowRoot!.querySelector("input") as unknown as HTMLElement).focus();

    expect(isTypingTarget()).toBe(true);
  });

  test("recognises a contenteditable surface inside a shadow root", () => {
    const host = hostWith(`<div contenteditable="true"></div>`);
    (host.shadowRoot!.querySelector("div") as unknown as HTMLElement).focus();

    expect(isTypingTarget()).toBe(true);
  });

  test("leaves ordinary elements free to trigger shortcuts", () => {
    const button = window.document.createElement("button");
    window.document.body.appendChild(button);

    expect(isTypingTarget(button as unknown as Element)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
