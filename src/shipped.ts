// The "Shipped" channel: a curated feed agents post to when they finish
// something worth showing — title, a short summary, and rich media. Media
// entries are ordinary artifacts (image / video / html), so the feed reuses
// the artifact store, serving, and sandboxing wholesale.
//
// Posts are UPDATABLE: the JSONL is an append-only log of revisions keyed by
// post id. Re-posting with the same id appends a new revision; the feed shows
// the latest one with a version badge, so an agent can keep refining a ship
// post as the work evolves (v1 "shipped", v2 "now with dark mode", ...).
//
// Image media is optimized on ingest (sharp: ≤1600px wide, webp) before it
// lands in the durable artifact store, so agents can throw full-size
// screenshots at lfg_ship without bloating data/artifacts.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config.ts";
import {
  createImageArtifact,
  createVideoArtifact,
  getImageArtifact,
  imageArtifactToMessage,
} from "./artifacts.ts";

const FILE = join(PATHS.data, "shipped.jsonl");
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv)$/i;
// gif stays untouched (animation); webp is already optimized.
const OPTIMIZABLE_EXT = /\.(png|jpe?g)$/i;
const MAX_MEDIA_WIDTH = 1600;
const WEBP_QUALITY = 82;

export type ShipPostRevision = {
  id: string;
  rev: number;
  ts: number;
  title: string;
  // Markdown. Kept short — this is a showcase caption, not a report.
  summary?: string;
  sessionId?: string;
  agent?: string;
  project?: string;
  // Artifact ids; hydrated to kind/url on read.
  media: string[];
};

export type ShipPostHydrated = ShipPostRevision & {
  firstTs: number;
  revisions: number;
  mediaItems: Array<{
    artifactId: string;
    kind: "image" | "video" | "html";
    url: string;
    name: string;
    caption?: string;
    version?: number;
    updatedAt?: number;
    lastRefreshedAt?: number;
    refreshStatus?: "idle" | "running" | "success" | "error";
  }>;
};

// Downscale + re-encode a screenshot before it enters the artifact store.
// Returns the artifact-ready path (a temp file the caller may clean up) or
// the original path when optimization doesn't apply/fails — a worse encode
// should never block a ship post.
async function optimizeImageForStore(path: string): Promise<{ path: string; temp: boolean }> {
  if (!OPTIMIZABLE_EXT.test(path)) return { path, temp: false };
  try {
    const { default: sharp } = await import("sharp");
    const out = join(tmpdir(), `lfg-ship-${randomBytes(6).toString("hex")}.webp`);
    await sharp(path)
      .resize({ width: MAX_MEDIA_WIDTH, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(out);
    return { path: out, temp: true };
  } catch {
    return { path, temp: false };
  }
}

function readRevisions(): ShipPostRevision[] {
  let raw = "";
  try {
    raw = readFileSync(FILE, "utf8");
  } catch {
    return [];
  }
  const rows: ShipPostRevision[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ShipPostRevision);
    } catch {}
  }
  return rows;
}

export async function addShipPost(input: {
  title: string;
  summary?: string;
  // Update an existing post in place by passing its id.
  id?: string;
  sessionId?: string;
  agent?: string;
  project?: string;
  // Local files to attach (screenshots, recordings) — optimized, then copied
  // into the artifact store; image/video picked by extension.
  mediaPaths?: Array<{ path: string; caption?: string }>;
  // Existing artifacts to embed (e.g. a live html dashboard).
  artifactIds?: string[];
  ts?: number;
}): Promise<ShipPostRevision> {
  const title = input.title?.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("title required");

  const prior = input.id
    ? readRevisions()
        .filter((r) => r.id === input.id)
        .sort((a, b) => b.rev - a.rev)[0]
    : undefined;
  if (input.id && !prior) throw new Error(`unknown ship post id: ${input.id}`);

  const media: string[] = [];
  for (const item of input.mediaPaths ?? []) {
    const sessionId = input.sessionId ?? prior?.sessionId;
    if (!sessionId) throw new Error("sessionId required to attach media files");
    if (VIDEO_EXT.test(item.path)) {
      media.push(createVideoArtifact({ sessionId, path: item.path, caption: item.caption }).id);
      continue;
    }
    const optimized = await optimizeImageForStore(item.path);
    try {
      media.push(
        createImageArtifact({ sessionId, path: optimized.path, caption: item.caption }).id,
      );
    } finally {
      if (optimized.temp) rmSync(optimized.path, { force: true });
    }
  }
  for (const id of input.artifactIds ?? []) {
    if (!getImageArtifact(id)) throw new Error(`unknown artifact id: ${id}`);
    media.push(id);
  }

  const post: ShipPostRevision = {
    id: prior?.id ?? randomBytes(6).toString("hex"),
    rev: (prior?.rev ?? 0) + 1,
    ts: input.ts ?? Date.now(),
    title: title.slice(0, 160),
    summary: input.summary?.trim().slice(0, 2000) || prior?.summary,
    sessionId: input.sessionId ?? prior?.sessionId,
    agent: input.agent ?? prior?.agent,
    project: input.project ?? prior?.project,
    // An update without new media keeps the existing gallery.
    media: media.length ? media : (prior?.media ?? []),
  };
  mkdirSync(dirname(FILE), { recursive: true });
  appendFileSync(FILE, JSON.stringify(post) + "\n");
  return post;
}

export function listShipPosts(
  limit = 50,
  offset = 0,
): { posts: ShipPostHydrated[]; total: number } {
  const byId = new Map<string, ShipPostRevision[]>();
  for (const row of readRevisions()) {
    const list = byId.get(row.id) ?? [];
    list.push(row);
    byId.set(row.id, list);
  }
  const merged = [...byId.values()]
    .map((revs) => {
      revs.sort((a, b) => a.rev - b.rev);
      const latest = revs[revs.length - 1];
      return { ...latest, firstTs: revs[0].ts, revisions: revs.length };
    })
    .sort((a, b) => b.ts - a.ts);
  // Hydration touches the artifact index per media id, so only the requested
  // page pays that cost — total lets the client know when to stop paging.
  const posts = merged.slice(offset, offset + limit).map((post) => ({
      ...post,
      mediaItems: post.media
        .map((id) => {
          const artifact = getImageArtifact(id);
          if (!artifact) return null;
          const message = imageArtifactToMessage(artifact);
          return {
            artifactId: id,
            kind: (artifact.media ?? "image") as "image" | "video" | "html",
            url: message.url,
            name: artifact.name,
            caption: artifact.caption,
            version: artifact.version,
            updatedAt: artifact.updatedAt ?? artifact.createdAt,
            lastRefreshedAt: artifact.refresh?.lastSuccessAt,
            refreshStatus: artifact.refresh?.status,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    }));
  return { posts, total: merged.length };
}
