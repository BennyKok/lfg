import { describe, expect, test, beforeEach } from "bun:test";

// Minimal document stub — this module touches exactly one attribute.
function installDocument() {
  const dataset: Record<string, string> = {};
  (globalThis as { document?: unknown }).document = {
    documentElement: { dataset },
  };
  return dataset;
}

async function freshModule() {
  // Bust the module cache so the counter starts at zero per test.
  return (await import(
    `../web/src/lib/surface-attribute.ts?t=${Math.random()}`
  )) as typeof import("../web/src/lib/surface-attribute.ts");
}

describe("the surface attribute is reference counted", () => {
  let dataset: Record<string, string>;
  beforeEach(() => {
    dataset = installDocument();
  });

  test("the first surface out does not strip styles off the one still mounted", async () => {
    // omg keeps the Computer surface mounted off-screen while you open
    // Settings. Every rule in the packaged stylesheet is prefixed with
    // html[data-lfg-app-surface], so deleting it on the FIRST unmount left the
    // surviving, visible surface completely unstyled.
    const { claimSurfaceAttribute } = await freshModule();
    const releaseApp = claimSurfaceAttribute();
    const releaseSettings = claimSurfaceAttribute();
    expect(dataset.lfgAppSurface).toBe("");

    releaseSettings();
    expect(dataset.lfgAppSurface).toBe("");

    releaseApp();
    expect(dataset.lfgAppSurface).toBeUndefined();
  });

  test("a doubled release cannot decrement past zero", async () => {
    // Strict Mode double-invokes effects. A release that counted twice would
    // let the NEXT unmount clear the attribute out from under a live surface.
    const { claimSurfaceAttribute } = await freshModule();
    const release = claimSurfaceAttribute();
    release();
    release();
    const second = claimSurfaceAttribute();
    expect(dataset.lfgAppSurface).toBe("");
    second();
    expect(dataset.lfgAppSurface).toBeUndefined();
  });
});
