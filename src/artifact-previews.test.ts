import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { getOrCreateImagePreview, imagePreviewPath } from "./artifact-previews.ts";
import type { ImageArtifact } from "./artifacts.ts";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((path) => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

describe("artifact image previews", () => {
  test("creates one bounded WebP and reuses the disk cache", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "lfg-preview-test-"));
    cleanup.add(sourceDir);
    const sourcePath = join(sourceDir, "large.png");
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: "#336699" },
    })
      .png()
      .toFile(sourcePath);

    const id = `test-${randomUUID()}`;
    const previewPath = imagePreviewPath(id);
    cleanup.add(previewPath);
    const artifact: ImageArtifact = {
      id,
      sessionId: randomUUID(),
      createdAt: Date.now(),
      media: "image",
      sourcePath,
      filePath: sourcePath,
      name: "large.png",
      mimeType: "image/png",
      size: Bun.file(sourcePath).size,
    };

    const [first, concurrent] = await Promise.all([
      getOrCreateImagePreview(artifact),
      getOrCreateImagePreview(artifact),
    ]);
    expect(first).toBe(previewPath);
    expect(concurrent).toBe(previewPath);
    const metadata = await sharp(first).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(1200);
    expect(metadata.height).toBe(800);

    const firstModified = Bun.file(first).lastModified;
    expect(await getOrCreateImagePreview(artifact)).toBe(first);
    expect(Bun.file(first).lastModified).toBe(firstModified);
  });
});
