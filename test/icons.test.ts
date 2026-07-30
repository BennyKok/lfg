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
