import { expect, test } from "bun:test";
import {
  COMPRESS_MIN_BYTES,
  compressImageFile,
  compressedName,
  fallbackEncodeType,
  isCompressibleImage,
  targetDimensions,
  type RenderImage,
} from "../web/src/lib/image-compress";

function imageFile(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** A render that always produces `bytes` of `type`, recording what it was asked. */
function fakeRender(bytes: number, type = "image/webp") {
  const calls: { type: string; maxDimension: number; quality: number }[] = [];
  const render: RenderImage = async (_file, options) => {
    calls.push(options);
    return new Blob([new Uint8Array(bytes)], { type });
  };
  return { render, calls };
}

test("small images upload untouched", () => {
  expect(isCompressibleImage(imageFile("a.jpg", "image/jpeg", 1024))).toBe(false);
  expect(
    isCompressibleImage(imageFile("a.jpg", "image/jpeg", COMPRESS_MIN_BYTES)),
  ).toBe(true);
});

test("animated and vector images are never re-encoded", () => {
  const size = COMPRESS_MIN_BYTES * 8;
  expect(isCompressibleImage(imageFile("loop.gif", "image/gif", size))).toBe(false);
  expect(isCompressibleImage(imageFile("logo.svg", "image/svg+xml", size))).toBe(false);
  expect(isCompressibleImage(imageFile("doc.pdf", "application/pdf", size))).toBe(false);
});

test("a typeless HEIC from an iOS share sheet is still recognised", () => {
  expect(isCompressibleImage(imageFile("IMG_0850.HEIC", "", COMPRESS_MIN_BYTES))).toBe(
    true,
  );
});

test("target dimensions fit the long edge without upscaling", () => {
  expect(targetDimensions(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
  expect(targetDimensions(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
  // Already small: re-encoded at its own size rather than blown up.
  expect(targetDimensions(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  // An extreme aspect ratio must not round the short edge away to nothing.
  expect(targetDimensions(8000, 3, 2048)).toEqual({ width: 2048, height: 1 });
});

test("the compressed copy is renamed to match its new bytes", () => {
  expect(compressedName("IMG_0850.HEIC", "image/webp")).toBe("IMG_0850.webp");
  expect(compressedName("shot.png", "image/jpeg")).toBe("shot.jpg");
  expect(compressedName("no-extension", "image/webp")).toBe("no-extension.webp");
  expect(compressedName("my.photo.v2.jpeg", "image/webp")).toBe("my.photo.v2.webp");
});

test("compressImageFile swaps in the smaller copy", async () => {
  const original = imageFile("IMG_0850.jpg", "image/jpeg", 4_000_000);
  const { render, calls } = fakeRender(300_000);

  const result = await compressImageFile(original, { render });

  expect(result.compressed).toBe(true);
  expect(result.file.size).toBe(300_000);
  expect(result.file.name).toBe("IMG_0850.webp");
  expect(result.file.type).toBe("image/webp");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.type).toBe("image/webp");
});

test("a re-encode that barely helps keeps the original bytes", async () => {
  const original = imageFile("flat.png", "image/png", 1_000_000);
  const { render } = fakeRender(950_000);

  const result = await compressImageFile(original, { render });

  expect(result.compressed).toBe(false);
  expect(result.file).toBe(original);
});

test("an image below the size floor is never decoded", async () => {
  const original = imageFile("tiny.png", "image/png", 4_096);
  const { render, calls } = fakeRender(1_000);

  const result = await compressImageFile(original, { render });

  expect(result.file).toBe(original);
  expect(calls).toHaveLength(0);
});

test("a decode failure falls back to uploading the original", async () => {
  const original = imageFile("broken.heic", "image/heic", 3_000_000);
  const render: RenderImage = async () => {
    throw new Error("unsupported codec");
  };

  const result = await compressImageFile(original, { render });

  expect(result.compressed).toBe(false);
  expect(result.file).toBe(original);
});

test("a browser without WebP encoding re-encodes in a format it does support", async () => {
  // Safari without WebP encoding hands back a PNG instead of failing, which
  // for a photo is bigger than what we started with.
  const calls: string[] = [];
  const render: RenderImage = async (_file, options) => {
    calls.push(options.type);
    if (options.type === "image/webp") {
      return new Blob([new Uint8Array(9_000_000)], { type: "image/png" });
    }
    return new Blob([new Uint8Array(400_000)], { type: options.type });
  };

  const photo = await compressImageFile(
    imageFile("IMG_0850.jpg", "image/jpeg", 4_000_000),
    { render },
  );

  expect(calls).toEqual(["image/webp", "image/jpeg"]);
  expect(photo.compressed).toBe(true);
  expect(photo.file.name).toBe("IMG_0850.jpg");
  expect(photo.file.type).toBe("image/jpeg");
});

test("a PNG source falls back to PNG so transparency survives", async () => {
  const calls: string[] = [];
  const render: RenderImage = async (_file, options) => {
    calls.push(options.type);
    return new Blob([new Uint8Array(200_000)], { type: "image/png" });
  };

  const shot = await compressImageFile(
    imageFile("screenshot.png", "image/png", 2_000_000),
    { render },
  );

  // The first attempt already came back as the PNG fallback, so there is no
  // point asking for it a second time.
  expect(calls).toEqual(["image/webp"]);
  expect(shot.file.type).toBe("image/png");
  expect(shot.file.name).toBe("screenshot.png");
  expect(fallbackEncodeType("image/png")).toBe("image/png");
});
