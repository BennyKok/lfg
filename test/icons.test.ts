import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

describe("LFG icon assets", () => {
  // The mark must be real outlines, not a bitmap. It shipped for five weeks as
  // a grid of ~680 8.28px <rect>s — a 34x26 pixel image in SVG clothing. The
  // header draws it in a 24px box where the glyph gets ~11.7px for 32 source
  // pixels: 0.36px each, well under one device pixel even at DPR 3, so every
  // stroke was averaged into the background and came out grey instead of white.
  // Outlines rasterize against the actual device grid, so they stay crisp.
  // A handful of <rect>/<path> is normal artwork; hundreds means a pixel grid.
  test("keeps the LFG mark as true vector letterforms, never a bitmap", async () => {
    const source = await readFile("web/public/icon.svg", "utf8");
    expect(source).toContain('viewBox="0 0 512 512"');
    expect(source).not.toContain("<image");

    const rects = source.match(/<rect/g)?.length ?? 0;
    expect(rects).toBeLessThan(12);

    // A traced bitmap also hides as one path of hundreds of L commands.
    for (const [, d] of source.matchAll(/\sd="([^"]+)"/g)) {
      expect((d.match(/L/g)?.length ?? 0)).toBeLessThan(60);
    }
  });

  test("ships the small placement variant as the same crisp vector", async () => {
    const source = await readFile("web/public/icon-small.svg", "utf8");
    expect(source).toContain('viewBox="0 0 512 512"');
    expect(source).not.toContain("<image");
    expect((source.match(/<rect/g)?.length ?? 0)).toBeLessThan(12);

    // Vector needs no size-specific artwork: no variants, no @media swap.
    expect(source).not.toContain("@media");
    expect(source).not.toContain('id="full"');
    expect(source).not.toContain('id="mini"');

    for (const path of [
      "web/src/App.tsx",
      "web/src/components/pwa-install.tsx",
      "web/src/components/embedded-connect-gate.tsx",
    ]) {
      const ui = await readFile(path, "utf8");
      expect(ui).not.toContain('lfgAssetUrl("/icon.svg")');
    }

    const server = await readFile("src/commands/serve.ts", "utf8");
    expect(server).toContain('"/icon-small.svg"');

    const paths = await readFile("web/src/lib/icon-assets.ts", "utf8");
    expect(paths).toContain("/icon-small.svg?v=");
  });

  test("forces one service-worker cache reset for stale PWA shells", async () => {
    const worker = await readFile("web/public/sw.js", "utf8");
    expect(worker).toContain("lfg-cache-reset-crisp-icon-v1");
    // Black standalone launches (stale shell + missing hashed chunks) get a
    // one-time purge that also navigates open clients — purge alone left
    // shells whose entry chunk never ran still black. v3 also refuses to
    // cache/serve empty black HTML as a shell fallback.
    expect(worker).toContain("lfg-cache-reset-black-shell-v3");
    expect(worker).toContain("forceTakeoverAndPurgeShellCaches");
    expect(worker).toContain("reloadControlledClients");
    expect(worker).toContain("offlineShellResponse");
    expect(worker).toContain("isUsableAppShell");
    expect(worker).toContain("matchUsableShell");
    expect(worker).toContain('cache: "no-store"');
    expect(worker).toContain('key.startsWith("lfg-shell-")');
    expect(worker).toContain('key.startsWith("lfg-assets-")');
    expect(worker).toContain("await self.skipWaiting()");
    expect(worker).toContain("keys.includes(CRISP_ICON_CACHE_RESET)");
    expect(worker).toContain("keys.includes(BLACK_SHELL_CACHE_RESET)");

    // Recovery must not depend on the app bundle loading (that is the failure).
    const index = await readFile("web/index.html", "utf8");
    expect(index).toContain('navigator.serviceWorker.register("/sw.js")');
    expect(index).toContain("lfg:boot-recover:");
    expect(index).toContain("LFG_FORCE_RELOAD");
    // Stuck black splash must surface a recovery UI, not spin forever.
    expect(index).toContain("showStuckSplashRecovery");
    expect(index).toContain("lfg did not finish loading");
    // Never reload on controllerchange when sessionStorage is unusable —
    // that path is an infinite black flash loop on some iOS installs.
    expect(index).toContain('if (!storageSet("lfg:sw-controller-reload", "1")) return;');
  });

  // A suspended PWA can run one shell across many deploys, so a waiting worker
  // must be adopted on resume rather than left behind a toast nobody taps.
  test("adopts a waiting worker when the app is resumed", async () => {
    const main = await readFile("web/src/main.tsx", "utf8");
    expect(main).toContain("adoptPendingUpdate");
    expect(main).toMatch(
      /visibilitychange[\s\S]{0,220}adoptPendingUpdate\(\)/,
    );
    // Still only ever asks while the app is in the foreground.
    expect(main).toContain("promptUpdate");
  });

  test("ships each generated PNG at its declared size", async () => {
    const assets = [
      ["web/public/icon-192.png", 192, 192],
      ["web/public/icon-512.png", 512, 512],
      ["web/public/icon-maskable-512.png", 512, 512],
      ["web/public/apple-touch-icon.png", 180, 180],
      ["docs/images/lfg-icon.png", 192, 192],
    ] as const;

    for (const [path, width, height] of assets) {
      const metadata = await sharp(path).metadata();
      expect([metadata.width, metadata.height]).toEqual([width, height]);
    }
  });

  test("keeps the maskable icon fully opaque", async () => {
    const metadata = await sharp("web/public/icon-maskable-512.png").metadata();
    expect(metadata.hasAlpha).toBe(false);
  });
});
