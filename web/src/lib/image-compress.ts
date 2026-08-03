/**
 * Downscale composer image attachments in the browser, before they upload.
 *
 * A photo straight off a phone is 3-12 MB of 4032x3024 JPEG. Nothing
 * downstream wants that: the agent reads it as vision input (which is capped
 * well below that resolution anyway), the transcript renders it in a chip, and
 * in between it has to crawl up a phone's uplink while the user waits on a
 * progress bar. So the default is a downscaled re-encode, and the full-size
 * bytes are only uploaded when the user explicitly asks for HD.
 *
 * Re-encoding also drops EXIF, which means camera GPS coordinates stop riding
 * along with every screenshot-of-a-photo someone drags into the composer.
 *
 * The decode/encode step is injectable (`render`) because canvas isn't
 * implemented in the test DOM — the eligibility, sizing and naming rules are
 * pure functions and tested directly.
 */

/** Longest edge of the downscaled copy. Above ~2k nothing downstream benefits. */
export const COMPRESS_MAX_DIMENSION = 2048;

/** Lossy quality for the re-encode. 0.82 is visually clean on photos and UI. */
export const COMPRESS_QUALITY = 0.82;

/**
 * Files this small already upload in one chunk, and re-encoding them tends to
 * *grow* small PNG/UI screenshots. Not worth the decode.
 */
export const COMPRESS_MIN_BYTES = 256 * 1024;

/**
 * Keep the compressed copy only when it is meaningfully smaller. A marginal win
 * isn't worth handing the agent a re-encoded (slightly lossier) image.
 */
export const COMPRESS_MIN_SAVINGS = 0.15;

// Raster types the browser can decode and we can safely re-encode.
//
// GIF is excluded because a canvas re-encode would flatten an animation to its
// first frame, and SVG because rasterizing a vector is a downgrade, not a
// compression.
const COMPRESSIBLE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const COMPRESSIBLE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
]);

export type CompressibleFile = { name: string; type: string; size: number };

function extensionOf(name: string): string {
  const leaf = name.split("/").pop() || "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether this attachment is worth downscaling.
 *
 * Falls back to the extension because iOS share sheets and some pickers hand
 * over HEIC files with an empty MIME type.
 */
export function isCompressibleImage(file: CompressibleFile): boolean {
  if (file.size < COMPRESS_MIN_BYTES) return false;
  const type = file.type.toLowerCase();
  if (type) return COMPRESSIBLE_TYPES.has(type);
  return COMPRESSIBLE_EXTENSIONS.has(extensionOf(file.name));
}

/**
 * Fit `width`x`height` inside `maxDimension` without upscaling, preserving
 * aspect ratio. An already-small image keeps its dimensions and is re-encoded
 * in place (a 12 MP-quality JPEG at 1600px still compresses well).
 */
export function targetDimensions(
  width: number,
  height: number,
  maxDimension = COMPRESS_MAX_DIMENSION,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 0, height: 0 };
  if (longest <= maxDimension) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = maxDimension / longest;
  return {
    // Never round down to zero on an extreme aspect ratio (a 8000x3 banner).
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Encoding target. WebP wins on both photos and flat UI screenshots and keeps
 * alpha, so it is the preference regardless of the source type.
 */
export const PREFERRED_ENCODE_TYPE = "image/webp";

/**
 * What to use when a browser refuses to encode WebP (older Safari silently
 * hands back a PNG instead). PNG sources stay PNG so transparency survives;
 * everything else is a photo format where JPEG is the right fallback.
 */
export function fallbackEncodeType(sourceType: string): string {
  return sourceType.toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
}

const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/**
 * Rename to match the re-encoded bytes. The extension is load-bearing: the
 * transcript decides whether an upload is displayable from it, and the server
 * serves uploads under an extension allowlist.
 */
export function compressedName(name: string, encodeType: string): string {
  const extension = EXTENSION_FOR_TYPE[encodeType.toLowerCase()] || "jpg";
  const leaf = name || "image";
  const dot = leaf.lastIndexOf(".");
  const base = dot > 0 ? leaf.slice(0, dot) : leaf;
  return `${base}.${extension}`;
}

export type RenderOptions = {
  maxDimension: number;
  quality: number;
  type: string;
};

/** Decode, downscale and re-encode. Returns null when the browser can't. */
export type RenderImage = (
  file: File,
  options: RenderOptions,
) => Promise<Blob | null>;

export type CompressImageOptions = {
  maxDimension?: number;
  quality?: number;
  render?: RenderImage;
};

export type CompressedImage = {
  /** The file to upload: the downscaled copy, or the original when it wins. */
  file: File;
  /** Whether `file` is a re-encoded copy rather than the original bytes. */
  compressed: boolean;
};

/**
 * Produce the upload-ready copy of an image attachment.
 *
 * Never throws and never returns nothing: any failure (unsupported codec, a
 * decode error, an OOM on a huge image, or a re-encode that came out bigger)
 * falls back to the original file, because a large upload is always better
 * than a lost attachment.
 */
export async function compressImageFile(
  file: File,
  options: CompressImageOptions = {},
): Promise<CompressedImage> {
  if (!isCompressibleImage(file)) return { file, compressed: false };

  const maxDimension = options.maxDimension ?? COMPRESS_MAX_DIMENSION;
  const quality = options.quality ?? COMPRESS_QUALITY;
  const render = options.render ?? renderDownscaledImage;

  let blob: Blob | null = null;
  try {
    blob = await render(file, {
      maxDimension,
      quality,
      type: PREFERRED_ENCODE_TYPE,
    });
    // A browser that can't encode WebP quietly returns another type rather than
    // failing, so re-encode in a format it does support instead of shipping a
    // surprise PNG of a photo.
    if (blob && blob.type && blob.type !== PREFERRED_ENCODE_TYPE) {
      const fallback = fallbackEncodeType(file.type);
      if (blob.type !== fallback) {
        blob = await render(file, { maxDimension, quality, type: fallback });
      }
    }
  } catch {
    return { file, compressed: false };
  }

  if (!blob || !blob.size) return { file, compressed: false };
  if (blob.size > file.size * (1 - COMPRESS_MIN_SAVINGS)) {
    return { file, compressed: false };
  }

  const type = blob.type || PREFERRED_ENCODE_TYPE;
  const compressed = new File([blob], compressedName(file.name, type), {
    type,
    lastModified: file.lastModified,
  });
  return { file: compressed, compressed: true };
}

async function decodeImage(
  file: File,
): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === "function") {
    // `from-image` applies the EXIF rotation, which the re-encode then bakes in
    // — otherwise stripping EXIF would leave phone photos lying on their side.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("could not decode image"));
      element.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** The DOM implementation of {@link RenderImage}. */
export const renderDownscaledImage: RenderImage = async (file, options) => {
  const decoded = await decodeImage(file);
  try {
    const size = targetDimensions(decoded.width, decoded.height, options.maxDimension);
    if (!size.width || !size.height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(decoded.source, 0, 0, size.width, size.height);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), options.type, options.quality);
    });
  } finally {
    decoded.release();
  }
};
