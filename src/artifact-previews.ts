import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PATHS } from "./config.ts";
import type { ImageArtifact } from "./artifacts.ts";

const PREVIEWS_DIR = join(PATHS.data, "artifacts", "previews");
const PREVIEW_VERSION = "v1";
const PREVIEW_WIDTH = 1200;

// Coalesce simultaneous requests for a new image. The finished files provide
// the persistent cache across requests and server restarts.
const pending = new Map<string, Promise<string>>();

export function imagePreviewPath(artifactId: string): string {
  return join(PREVIEWS_DIR, `${artifactId}-${PREVIEW_VERSION}.webp`);
}

async function createImagePreview(artifact: ImageArtifact, outputPath: string): Promise<string> {
  await mkdir(PREVIEWS_DIR, { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await sharp(artifact.filePath, { animated: false })
      .rotate()
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .webp({ quality: 76, effort: 4, smartSubsample: true })
      .toFile(temporaryPath);
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getOrCreateImagePreview(artifact: ImageArtifact): Promise<string> {
  const outputPath = imagePreviewPath(artifact.id);
  if (await Bun.file(outputPath).exists()) return outputPath;

  const active = pending.get(artifact.id);
  if (active) return active;

  const generation = createImagePreview(artifact, outputPath).finally(() => {
    pending.delete(artifact.id);
  });
  pending.set(artifact.id, generation);
  return generation;
}
