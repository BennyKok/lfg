import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config.ts";
import type { SessionMsg } from "./sessions.ts";

function root(): string {
  return join(PATHS.data, "artifacts");
}

function filesDir(): string {
  return join(root(), "files");
}

function indexPath(): string {
  return join(root(), "index.json");
}
const UUID = /^[0-9a-fA-F-]{36}$/;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
// Agents commonly retry a display tool after a transport/indexing error.  The
// media copy may already be durable at that point, so treat an identical call
// in this short window as the same publish instead of creating a second chat
// message.  Deliberately displaying the same file again later still works.
const RETRY_DEDUPE_MS = 5 * 60 * 1000;

export type MediaKind = "image" | "video" | "html";

export type ArtifactRefreshStatus = "idle" | "running" | "success" | "error";

export type ArtifactRefreshConfig = {
  scriptPath: string;
  argv: string[];
  scopeRoot: string;
  intervalMs: number;
  timeoutMs: number;
  enabled: boolean;
  configuredAt: number;
  status: ArtifactRefreshStatus;
  lastStartedAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
};

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
  sourceMtimeMs?: number;
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
  // Server-side script refresh configuration. This lives with the stable
  // artifact record so schedules and their status survive server restarts.
  refresh?: ArtifactRefreshConfig;
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
  refresh?: ArtifactRefreshConfig;
};

function readIndex(): Record<string, ImageArtifact> {
  try {
    return JSON.parse(readFileSync(indexPath(), "utf8")) as Record<string, ImageArtifact>;
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, ImageArtifact>): void {
  const path = indexPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(index, null, 2));
  renameSync(temp, path);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
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

  const caption = cleanText(input.caption, 300);
  const alt = cleanText(input.alt, 160);
  const now = Date.now();
  const existing = Object.values(readIndex())
    .filter((artifact) =>
      artifact.sessionId === sessionId &&
      (artifact.media ?? "image") === media &&
      artifact.sourcePath === sourcePath &&
      artifact.sourceMtimeMs === st.mtimeMs &&
      artifact.size === st.size &&
      artifact.caption === caption &&
      artifact.alt === alt &&
      now - artifact.createdAt >= 0 &&
      now - artifact.createdAt <= RETRY_DEDUPE_MS
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (existing) return existing;

  const dir = filesDir();
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const ext = extname(sourcePath).toLowerCase();
  const filePath = join(dir, `${id}${ext}`);
  copyFileSync(sourcePath, filePath);

  const artifact: ImageArtifact = {
    id,
    sessionId,
    createdAt: now,
    media,
    sourcePath,
    sourceMtimeMs: st.mtimeMs,
    filePath,
    name: basename(sourcePath),
    mimeType,
    size: st.size,
    caption,
    alt,
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
  // undefined preserves the current configuration; null removes it.
  refresh?: ArtifactRefreshConfig | null;
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
  const dir = filesDir();
  mkdirSync(dir, { recursive: true });
  const filePath = existing?.filePath ?? join(dir, `${id}.html`);
  // A refresh never exposes partial output: write beside the destination and
  // atomically rename only after the complete document is durable.
  atomicWrite(filePath, html);

  // `imageArtifactMessagesSince` uses a strict greater-than cursor. Keep this
  // monotonic even when two publishes land in the same millisecond so an open
  // client reliably receives every new version without a duplicate card.
  const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
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
    refresh: input.refresh === undefined ? existing?.refresh : input.refresh ?? undefined,
  };
  index[id] = artifact;
  writeIndex(index);
  return artifact;
}

export function updateHtmlArtifactRefresh(input: {
  id: string;
  sessionId: string;
  refresh: ArtifactRefreshConfig | null;
}): ImageArtifact {
  const index = readIndex();
  const artifact = index[input.id];
  if (!artifact || artifact.media !== "html") throw new Error("html artifact not found");
  if (artifact.sessionId !== input.sessionId) throw new Error("artifact belongs to a different session");
  artifact.refresh = input.refresh ?? undefined;
  index[input.id] = artifact;
  writeIndex(index);
  return artifact;
}

export function updateHtmlArtifactRefreshStatus(input: {
  id: string;
  patch: Partial<Pick<ArtifactRefreshConfig, "status" | "lastStartedAt" | "lastSuccessAt" | "lastError">>;
}): ImageArtifact | null {
  const index = readIndex();
  const artifact = index[input.id];
  if (!artifact || artifact.media !== "html" || !artifact.refresh) return null;
  const refresh = { ...artifact.refresh, ...input.patch };
  if (input.patch.lastError === undefined && "lastError" in input.patch) delete refresh.lastError;
  artifact.refresh = refresh;
  index[input.id] = artifact;
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
    refresh: artifact.refresh,
  };
}

export function imageArtifactMessagesSince(sessionId: string, after: number): ImageArtifactMessage[] {
  return listImageArtifacts(sessionId)
    .filter((artifact) => (artifact.updatedAt ?? artifact.createdAt) > after)
    .map(imageArtifactToMessage);
}

// Older servers could persist a media artifact and then report the display call
// as failed when only the transcript-index write was busy. Agent retries left
// two durable rows with different artifact ids. Collapse that legacy retry pair
// at the transcript boundary without deleting either stored file or DB row.
export function collapseArtifactRetryMessages<T extends {
  kind: string;
  ts?: number | null;
  name?: string;
  mimeType?: string;
  size?: number;
  caption?: string;
  alt?: string;
}>(messages: T[]): T[] {
  const out: T[] = [];
  const lastBySignature = new Map<string, number>();
  for (const message of messages) {
    if ((message.kind !== "image" && message.kind !== "video") || message.ts == null) {
      out.push(message);
      continue;
    }
    const signature = JSON.stringify([
      message.kind,
      message.name ?? "",
      message.mimeType ?? "",
      message.size ?? -1,
      message.caption ?? "",
      message.alt ?? "",
    ]);
    const previousAt = lastBySignature.get(signature);
    if (previousAt != null && message.ts >= previousAt && message.ts - previousAt <= RETRY_DEDUPE_MS) continue;
    lastBySignature.set(signature, message.ts);
    out.push(message);
  }
  return out;
}

export function hydrateImageArtifactMessage(message: SessionMsg): SessionMsg | ImageArtifactMessage {
  if (message.kind !== "image" && message.kind !== "video" && message.kind !== "html") return message;
  const artifactId = message.id?.startsWith("artifact-") ? message.id.slice("artifact-".length) : null;
  if (!artifactId) return message;
  const artifact = getImageArtifact(artifactId);
  return artifact ? imageArtifactToMessage(artifact) : message;
}
