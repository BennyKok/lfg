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

// icon-small.svg is what every small UI placement loads (see icon-assets.ts).
//
// It exists because the mark used to be a bitmap — a grid of ~8px <rect>s — and
// a bitmap has to be redrawn coarser to survive a 24px box. That artwork shipped
// two variants in one file, #full and #mini, swapped by an inline @media query,
// and this step sliced #mini out.
//
// The mark is true vector letterforms now, so there is nothing to slice: real
// outlines rasterize crisply at any size and the small file is just a copy. The
// separate route stays so the app keeps one stable URL to cache-bust, and so
// re-introducing a size-specific variant later is a change here and nowhere
// else. If the source ever carries variants again, isolate them; otherwise copy.
async function generateSmallIcon(): Promise<void> {
  const source = await readFile(resolve(webPublic, "icon.svg"), "utf8");

  const hasSizeVariants =
    source.includes('id="full"') && source.includes('id="mini"');

  if (!hasSizeVariants) {
    await writeFile(resolve(webPublic, "icon-small.svg"), source);
    return;
  }

  const small = source
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<g id="full"[\s\S]*?<\/g>/, "")
    .replace('id="mini"', 'id="mark"');

  if (small.includes('id="full"') || small.includes("@media")) {
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
