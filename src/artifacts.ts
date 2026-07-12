import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config.ts";
import type { SessionMsg } from "./sessions.ts";

const ROOT = join(PATHS.data, "artifacts");
const FILES_DIR = join(ROOT, "files");
const INDEX_PATH = join(ROOT, "index.json");
const UUID = /^[0-9a-fA-F-]{36}$/;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

export type MediaKind = "image" | "video";

const IMAGE_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
};

export type ImageArtifact = {
  id: string;
  sessionId: string;
  createdAt: number;
  // "image" (default for legacy entries that predate video support) or "video".
  media?: MediaKind;
  sourcePath: string;
  filePath: string;
  name: string;
  mimeType: string;
  size: number;
  caption?: string;
  alt?: string;
};

export type ImageArtifactMessage = SessionMsg & {
  kind: MediaKind;
  artifactId: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
  caption?: string;
  alt?: string;
};

function readIndex(): Record<string, ImageArtifact> {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf8")) as Record<string, ImageArtifact>;
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, ImageArtifact>): void {
  mkdirSync(dirname(INDEX_PATH), { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function cleanText(value: string | undefined, max: number): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function imageMimeFor(path: string): string | null {
  return IMAGE_TYPES[extname(path).toLowerCase()] ?? null;
}

function videoMimeFor(path: string): string | null {
  return VIDEO_TYPES[extname(path).toLowerCase()] ?? null;
}

function createMediaArtifact(
  input: {
    sessionId: string;
    path: string;
    caption?: string;
    alt?: string;
  },
  media: MediaKind,
): ImageArtifact {
  const sessionId = input.sessionId.trim();
  if (!UUID.test(sessionId)) throw new Error("sessionId must be a UUID");

  if (!isAbsolute(input.path)) throw new Error(`${media} path must be absolute`);
  const sourcePath = resolve(input.path);
  const mimeType = media === "video" ? videoMimeFor(sourcePath) : imageMimeFor(sourcePath);
  if (!mimeType) {
    throw new Error(
      media === "video"
        ? "only mp4, m4v, webm, mov, and ogv videos can be displayed"
        : "only png, jpg, jpeg, webp, and gif images can be displayed",
    );
  }

  const maxBytes = media === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const st = statSync(sourcePath);
  if (!st.isFile()) throw new Error(`${media} path is not a file`);
  if (st.size <= 0) throw new Error(`${media} file is empty`);
  if (st.size > maxBytes) {
    throw new Error(`${media} file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
  }

  mkdirSync(FILES_DIR, { recursive: true });
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const ext = extname(sourcePath).toLowerCase();
  const filePath = join(FILES_DIR, `${id}${ext}`);
  copyFileSync(sourcePath, filePath);

  const artifact: ImageArtifact = {
    id,
    sessionId,
    createdAt: Date.now(),
    media,
    sourcePath,
    filePath,
    name: basename(sourcePath),
    mimeType,
    size: st.size,
    caption: cleanText(input.caption, 300),
    alt: cleanText(input.alt, 160),
  };
  const index = readIndex();
  index[id] = artifact;
  writeIndex(index);
  return artifact;
}

export function createImageArtifact(input: {
  sessionId: string;
  path: string;
  caption?: string;
  alt?: string;
}): ImageArtifact {
  return createMediaArtifact(input, "image");
}

export function createVideoArtifact(input: {
  sessionId: string;
  path: string;
  caption?: string;
  alt?: string;
}): ImageArtifact {
  return createMediaArtifact(input, "video");
}

export function getImageArtifact(id: string): ImageArtifact | null {
  return readIndex()[id] ?? null;
}

export function listImageArtifacts(sessionId: string): ImageArtifact[] {
  return Object.values(readIndex())
    .filter((artifact) => artifact.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function imageArtifactToMessage(artifact: ImageArtifact): ImageArtifactMessage {
  const label = artifact.caption || artifact.alt || artifact.name;
  return {
    id: `artifact-${artifact.id}`,
    role: "assistant",
    kind: artifact.media ?? "image",
    text: label,
    ts: artifact.createdAt,
    artifactId: artifact.id,
    url: `/api/artifacts/${encodeURIComponent(artifact.id)}`,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    caption: artifact.caption,
    alt: artifact.alt,
  };
}

export function imageArtifactMessagesSince(sessionId: string, after: number): ImageArtifactMessage[] {
  return listImageArtifacts(sessionId)
    .filter((artifact) => artifact.createdAt > after)
    .map(imageArtifactToMessage);
}

export function hydrateImageArtifactMessage(message: SessionMsg): SessionMsg | ImageArtifactMessage {
  if (message.kind !== "image" && message.kind !== "video") return message;
  const artifactId = message.id?.startsWith("artifact-") ? message.id.slice("artifact-".length) : null;
  if (!artifactId) return message;
  const artifact = getImageArtifact(artifactId);
  return artifact ? imageArtifactToMessage(artifact) : message;
}
