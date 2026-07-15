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

export type MediaKind = "image" | "video" | "html";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const ARTIFACT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

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
  // Updatable artifacts (html): version bumps on every re-publish so live-ws
  // re-emits the message and the client refreshes the card in place.
  version?: number;
  updatedAt?: number;
  title?: string;
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
  version?: number;
  title?: string;
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

// HTML artifacts are UPDATABLE: re-publishing with the same id overwrites the
// file and bumps `version`/`updatedAt`. The stable message id (`artifact-<id>`)
// means the client upserts the card in place — that's what makes a "live
// dashboard" just an agent re-publishing the same artifact on an interval.
export function publishHtmlArtifact(input: {
  sessionId: string;
  html: string;
  id?: string;
  title?: string;
  caption?: string;
}): ImageArtifact {
  const sessionId = input.sessionId.trim();
  if (!UUID.test(sessionId)) throw new Error("sessionId must be a UUID");
  const html = input.html ?? "";
  if (!html.trim()) throw new Error("html content required");
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML_BYTES) throw new Error("html artifact is larger than 2 MB");

  const requestedId = input.id?.trim().toLowerCase();
  if (requestedId && !ARTIFACT_ID.test(requestedId)) {
    throw new Error("artifact id must be 3-64 chars: lowercase letters, digits, dashes");
  }

  const index = readIndex();
  const existing = requestedId ? index[requestedId] : null;
  if (existing && (existing.sessionId !== sessionId || (existing.media ?? "image") !== "html")) {
    throw new Error("artifact id belongs to a different session or media kind");
  }

  const id = requestedId ?? `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  mkdirSync(FILES_DIR, { recursive: true });
  const filePath = existing?.filePath ?? join(FILES_DIR, `${id}.html`);
  writeFileSync(filePath, html);

  const now = Date.now();
  const artifact: ImageArtifact = {
    id,
    sessionId,
    createdAt: existing?.createdAt ?? now,
    media: "html",
    sourcePath: filePath,
    filePath,
    name: `${id}.html`,
    mimeType: "text/html; charset=utf-8",
    size: bytes,
    caption: cleanText(input.caption, 300) ?? existing?.caption,
    title: cleanText(input.title, 120) ?? existing?.title,
    version: (existing?.version ?? 0) + 1,
    updatedAt: now,
  };
  index[id] = artifact;
  writeIndex(index);
  return artifact;
}

export function getImageArtifact(id: string): ImageArtifact | null {
  return readIndex()[id] ?? null;
}

export function listAllArtifacts(): ImageArtifact[] {
  return Object.values(readIndex()).sort(
    (a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt),
  );
}

export function listImageArtifacts(sessionId: string): ImageArtifact[] {
  return Object.values(readIndex())
    .filter((artifact) => artifact.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function imageArtifactToMessage(artifact: ImageArtifact): ImageArtifactMessage {
  const label = artifact.title || artifact.caption || artifact.alt || artifact.name;
  return {
    id: `artifact-${artifact.id}`,
    role: "assistant",
    kind: artifact.media ?? "image",
    text: label,
    // Updatable artifacts surface at their last-publish time so live-ws
    // re-emits them and the client re-sorts/refreshes in place.
    ts: artifact.updatedAt ?? artifact.createdAt,
    artifactId: artifact.id,
    url: `/api/artifacts/${encodeURIComponent(artifact.id)}`,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    caption: artifact.caption,
    alt: artifact.alt,
    version: artifact.version,
    title: artifact.title,
  };
}

export function imageArtifactMessagesSince(sessionId: string, after: number): ImageArtifactMessage[] {
  return listImageArtifacts(sessionId)
    .filter((artifact) => (artifact.updatedAt ?? artifact.createdAt) > after)
    .map(imageArtifactToMessage);
}

export function hydrateImageArtifactMessage(message: SessionMsg): SessionMsg | ImageArtifactMessage {
  if (message.kind !== "image" && message.kind !== "video" && message.kind !== "html") return message;
  const artifactId = message.id?.startsWith("artifact-") ? message.id.slice("artifact-".length) : null;
  if (!artifactId) return message;
  const artifact = getImageArtifact(artifactId);
  return artifact ? imageArtifactToMessage(artifact) : message;
}
