import { resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dir, "..");
const webPublic = resolve(root, "web/public");

async function render(
  source: string,
  output: string,
  size: number,
  opaque = false,
): Promise<void> {
  let image = sharp(resolve(webPublic, source), { density: 384 })
    .resize(size, size, { fit: "fill" });
  if (opaque) {
    image = image.flatten({ background: "#3b5bf6" });
  }
  await image.png().toFile(resolve(root, output));
}

await Promise.all([
  render("icon.svg", "web/public/icon-192.png", 192),
  render("icon.svg", "web/public/icon-512.png", 512),
  render("icon.svg", "web/public/apple-touch-icon.png", 180),
  render("icon.svg", "docs/images/lfg-icon.png", 192),
  render("icon-maskable.svg", "web/public/icon-maskable-512.png", 512, true),
]);
