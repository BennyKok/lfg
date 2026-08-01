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
    expect(metadata.width).toBe(1080);
    expect(metadata.height).toBe(720);

    const firstModified = Bun.file(first).lastModified;
    expect(await getOrCreateImagePreview(artifact)).toBe(first);
    expect(Bun.file(first).lastModified).toBe(firstModified);

    // The Notification Center's 52px squares get their own much smaller
    // variant, cached under a distinct name so it never collides with the
    // 1080px preview above.
    const thumbPath = imagePreviewPath(id, "thumb");
    cleanup.add(thumbPath);
    expect(thumbPath).not.toBe(previewPath);
    const thumb = await getOrCreateImagePreview(artifact, "thumb");
    expect(thumb).toBe(thumbPath);
    const thumbMeta = await sharp(thumb).metadata();
    expect(thumbMeta.format).toBe("webp");
    expect(thumbMeta.width).toBe(160);
    expect(Bun.file(thumb).size).toBeLessThan(Bun.file(first).size);
  });

  test("concurrent preview and thumb requests do not share a generation", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "lfg-preview-test-"));
    cleanup.add(sourceDir);
    const sourcePath = join(sourceDir, "wide.png");
    await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "#aa3344" },
    })
      .png()
      .toFile(sourcePath);

    const id = `test-${randomUUID()}`;
    cleanup.add(imagePreviewPath(id));
    cleanup.add(imagePreviewPath(id, "thumb"));
    const artifact: ImageArtifact = {
      id,
      sessionId: randomUUID(),
      createdAt: Date.now(),
      media: "image",
      sourcePath,
      filePath: sourcePath,
      name: "wide.png",
      mimeType: "image/png",
      size: Bun.file(sourcePath).size,
    };

    // Same artifact, both sizes at once: the in-flight map is keyed by variant,
    // so the thumb must not be handed the transcript-sized generation.
    const [preview, thumb] = await Promise.all([
      getOrCreateImagePreview(artifact, "preview"),
      getOrCreateImagePreview(artifact, "thumb"),
    ]);
    expect((await sharp(preview).metadata()).width).toBe(1080);
    expect((await sharp(thumb).metadata()).width).toBe(160);
  });

  test("bounds portrait previews by height instead of preserving oversized pixels", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "lfg-preview-test-"));
    cleanup.add(sourceDir);
    const sourcePath = join(sourceDir, "portrait.png");
    await sharp({
      create: { width: 1000, height: 2400, channels: 3, background: "#445566" },
    }).png().toFile(sourcePath);
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
      name: "portrait.png",
      mimeType: "image/png",
      size: Bun.file(sourcePath).size,
    };

    const metadata = await sharp(await getOrCreateImagePreview(artifact)).metadata();
    expect(metadata.width).toBe(450);
    expect(metadata.height).toBe(1080);
  });
});
