import { readFile, writeFile } from "node:fs/promises";
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

async function generateSmallIcon(): Promise<void> {
  const source = await readFile(resolve(webPublic, "icon.svg"), "utf8");
  const small = source
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<g id="full"[\s\S]*?<\/g>/, "")
    .replace('id="mini"', 'id="mark"');

  if (
    small === source ||
    small.includes('id="full"') ||
    small.includes("@media")
  ) {
    throw new Error("Could not isolate the small LFG icon artwork");
  }

  await writeFile(resolve(webPublic, "icon-small.svg"), small);
}

await generateSmallIcon();

await Promise.all([
  render("icon.svg", "web/public/icon-192.png", 192),
  render("icon.svg", "web/public/icon-512.png", 512),
  render("icon.svg", "web/public/apple-touch-icon.png", 180),
  render("icon.svg", "docs/images/lfg-icon.png", 192),
  render("icon-maskable.svg", "web/public/icon-maskable-512.png", 512, true),
]);
