import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

describe("LFG icon assets", () => {
  test("keeps the original responsive pixel-dissolve vector artwork", async () => {
    const source = await readFile("web/public/icon.svg", "utf8");
    expect(source).toContain('viewBox="0 0 512 512"');
    expect(source).toContain("@media (max-width:40px)");
    expect(source).toContain('id="full"');
    expect(source).toContain('id="mini"');
    expect(source).not.toContain("<image");
  });

  test("ships an explicit crisp variant for small UI placements", async () => {
    const source = await readFile("web/public/icon-small.svg", "utf8");
    expect(source).toContain('viewBox="0 0 512 512"');
    expect(source).toContain('id="mark"');
    expect(source).not.toContain("@media");
    expect(source).not.toContain('id="full"');
    expect(source).not.toContain("<image");

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
