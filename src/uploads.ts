import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

/**
 * Where attached files land.
 *
 * Uploads are deliberately not artifacts: they're inputs the user handed the
 * agent, they're referenced by absolute path inside the message text, and they
 * are allowed to disappear when the box reboots.
 */
export function uploadsDir(): string {
  return join(tmpdir(), "lfg-uploads");
}

// Only the types the transcript renders inline. An agent can still read any
// other upload off disk; the browser just never gets to ask for the bytes.
const UPLOAD_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export type UploadRequestResolution =
  | { filePath: string; contentType: string }
  | { error: string; status: number };

/**
 * Resolve a request for an uploaded attachment to a file inside the uploads dir.
 *
 * The client sends only a basename, so the directory is never client-supplied.
 * The checks below are belt-and-braces against a crafted name (path separators,
 * traversal, encoded escapes) reaching `join`, plus an extension allowlist so
 * this can't be turned into a generic read of whatever else is in tmpdir.
 */
export function resolveUploadRequest(rawName: string): UploadRequestResolution {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return { error: "invalid upload name", status: 400 };
  }
  if (!name || name.length > 255 || !/^[a-zA-Z0-9._-]+$/.test(name) || name.includes("..")) {
    return { error: "invalid upload name", status: 400 };
  }
  const contentType = UPLOAD_IMAGE_TYPES[extname(name).slice(1).toLowerCase()];
  if (!contentType) return { error: "unsupported upload type", status: 415 };
  const dir = resolve(uploadsDir());
  const filePath = resolve(dir, name);
  if (dirname(filePath) !== dir) return { error: "invalid upload name", status: 400 };
  return { filePath, contentType };
}
