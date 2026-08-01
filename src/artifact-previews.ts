import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadSharp } from "./native-deps.ts";
import { PATHS } from "./config.ts";
import type { ImageArtifact } from "./artifacts.ts";

const PREVIEWS_DIR = join(PATHS.data, "artifacts", "previews");
const PREVIEW_VERSION = "v2";

/**
 * Two bounded sizes, cached independently on disk.
 *
 * `preview` is the in-transcript/lightbox size. `thumb` exists because the
 * Notification Center renders media as a 52px square: serving the transcript
 * preview there meant ~65 KB of image per row to paint a postage stamp, and a
 * compact feed puts a lot of rows on screen at once.
 */
export type ImagePreviewVariant = "preview" | "thumb";
const VARIANT_WIDTH: Record<ImagePreviewVariant, number> = {
  // Transcript cards top out around 544 CSS pixels. 1080 keeps a crisp 2x
  // result while avoiding the extra pixels and bytes of the former 1200px
  // preview. A lower WebP quality is visually equivalent at card size and
  // materially quicker to transfer/decode.
  preview: 1080,
  thumb: 160,
};

const VARIANT_QUALITY: Record<ImagePreviewVariant, number> = {
  preview: 68,
  thumb: 64,
};

// Coalesce simultaneous requests for a new image. The finished files provide
// the persistent cache across requests and server restarts.
const pending = new Map<string, Promise<string>>();

export function imagePreviewPath(
  artifactId: string,
  variant: ImagePreviewVariant = "preview",
): string {
  // The original filename shape is the `preview` variant, so existing caches
  // stay valid and only the new size needs generating.
  const suffix = variant === "preview" ? "" : `-${variant}`;
  return join(PREVIEWS_DIR, `${artifactId}-${PREVIEW_VERSION}${suffix}.webp`);
}

async function createImagePreview(
  artifact: ImageArtifact,
  outputPath: string,
  variant: ImagePreviewVariant,
): Promise<string> {
  await mkdir(PREVIEWS_DIR, { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const sharp = await loadSharp();
    const image = sharp(artifact.filePath, { animated: false }).rotate();
    await image
      .resize(
        variant === "preview"
          ? {
              width: VARIANT_WIDTH.preview,
              height: VARIANT_WIDTH.preview,
              fit: "inside",
              withoutEnlargement: true,
            }
          : { width: VARIANT_WIDTH.thumb, withoutEnlargement: true },
      )
      .webp({ quality: VARIANT_QUALITY[variant], effort: 3, smartSubsample: true })
      .toFile(temporaryPath);
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getOrCreateImagePreview(
  artifact: ImageArtifact,
  variant: ImagePreviewVariant = "preview",
): Promise<string> {
  const outputPath = imagePreviewPath(artifact.id, variant);
  if (await Bun.file(outputPath).exists()) return outputPath;

  // Keyed by variant too, or a thumb request would be handed the in-flight
  // transcript generation and cache the wrong bytes under the thumb name.
  const key = `${artifact.id}:${variant}`;
  const active = pending.get(key);
  if (active) return active;

  const generation = createImagePreview(artifact, outputPath, variant).finally(() => {
    pending.delete(key);
  });
  pending.set(key, generation);
  return generation;
}

export async function deleteImagePreview(artifactId: string): Promise<void> {
  const variants: ImagePreviewVariant[] = ["preview", "thumb"];
  await Promise.all(
    variants.map((variant) => pending.get(`${artifactId}:${variant}`)?.catch(() => undefined)),
  );
  await Promise.all(
    variants.map((variant) => rm(imagePreviewPath(artifactId, variant), { force: true })),
  );
}
