import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { PATHS } from "./config.ts";

const UUID = /^[0-9a-fA-F-]{36}$/;
const MAX_ROWS = 1_000;
const RETRY_DEDUPE_MS = 30_000;

export type OriginDeliveryMedia = {
  path: string;
  kind: "image" | "video";
  mimeType: string;
};

export type OriginDelivery = {
  id: string;
  target: "origin";
  sessionId: string;
  text: string | null;
  media: OriginDeliveryMedia[];
  createdAt: number;
};

function storePath(): string {
  return join(PATHS.data, "origin-deliveries.json");
}

function readRows(): OriginDelivery[] {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(parsed) ? parsed as OriginDelivery[] : [];
  } catch {
    return [];
  }
}

function writeRows(rows: OriginDelivery[]): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify(rows.slice(-MAX_ROWS), null, 2));
  renameSync(temp, path);
}

function cleanText(value: string | undefined): string | null {
  const text = value?.trim();
  return text ? text.slice(0, 4_000) : null;
}

export function createOriginDelivery(input: {
  sessionId: string;
  text?: string;
  media?: OriginDeliveryMedia[];
  now?: number;
}): OriginDelivery {
  const sessionId = input.sessionId.trim();
  if (!UUID.test(sessionId)) throw new Error("sessionId must be a UUID");
  const text = cleanText(input.text);
  const media = (input.media ?? []).slice(0, 3);
  if (!text && media.length === 0) throw new Error("text or media required");
  for (const item of media) {
    if (!item.path.startsWith("/api/artifacts/")) throw new Error("delivery media must be an LFG artifact");
    if (item.kind !== "image" && item.kind !== "video") throw new Error("delivery media must be image or video");
  }

  const now = input.now ?? Date.now();
  const rows = readRows();
  const retry = [...rows].reverse().find((row) =>
    row.sessionId === sessionId &&
    row.text === text &&
    JSON.stringify(row.media) === JSON.stringify(media) &&
    now - row.createdAt >= 0 &&
    now - row.createdAt <= RETRY_DEDUPE_MS
  );
  if (retry) return retry;

  const delivery: OriginDelivery = {
    id: `delivery-${now.toString(36)}-${randomBytes(6).toString("hex")}`,
    target: "origin",
    sessionId,
    text,
    media,
    createdAt: now,
  };
  rows.push(delivery);
  writeRows(rows);
  return delivery;
}

export function listOriginDeliveries(sessionId: string, limit = 50): OriginDelivery[] {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  return readRows().filter((row) => row.sessionId === sessionId).slice(-bounded);
}
