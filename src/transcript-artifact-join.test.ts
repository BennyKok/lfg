import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { createImageArtifact, deleteArtifact, publishHtmlArtifact } from "./artifacts.ts";
import {
  indexArtifactMessage,
  indexedMessagePage,
  removeIndexedArtifact,
  resetTranscriptIndexConnectionForTests,
  sessionIndexKey,
  syncArtifactIndex,
} from "./transcript-index.ts";

const SESSION = "33333333-3333-4333-8333-333333333333";

describe("joined artifact + transcript reads", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-artifact-join-"));
    PATHS.data = join(root, "data");
    resetTranscriptIndexConnectionForTests();
  });

  afterEach(() => {
    resetTranscriptIndexConnectionForTests();
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("page reads return full media fields via JOIN (not a second hydrate pass)", async () => {
    const source = join(root, "shot.png");
    writeFileSync(source, "fake-png-bytes");
    const artifact = createImageArtifact({
      sessionId: SESSION,
      path: source,
      caption: "Join me",
      alt: "alt text",
    });
    const path = sessionIndexKey(SESSION);
    expect(indexArtifactMessage(path, SESSION, artifact)).toBe(1);

    // Second index of the same artifact updates in place — no duplicate row.
    expect(indexArtifactMessage(path, SESSION, artifact)).toBe(0);

    const page = await indexedMessagePage(path, SESSION, { limit: 20 });
    expect(page.messages).toHaveLength(1);
    const msg = page.messages[0] as {
      kind: string;
      artifactId?: string;
      url?: string;
      name?: string;
      mimeType?: string;
      size?: number;
      caption?: string;
      alt?: string;
    };
    expect(msg.kind).toBe("image");
    expect(msg.artifactId).toBe(artifact.id);
    expect(msg.url).toBe(`/api/artifacts/${encodeURIComponent(artifact.id)}`);
    expect(msg.name).toBe("shot.png");
    expect(msg.mimeType).toBe("image/png");
    expect(msg.size).toBe(artifact.size);
    expect(msg.caption).toBe("Join me");
    expect(msg.alt).toBe("alt text");
  });

  test("append order is sequential (no fractional timestamp offsets)", async () => {
    const path = sessionIndexKey(SESSION);
    const ids: string[] = [];
    for (const name of ["a.png", "b.png", "c.png"]) {
      const source = join(root, name);
      writeFileSync(source, `bytes-${name}`);
      const artifact = createImageArtifact({ sessionId: SESSION, path: source, caption: name });
      ids.push(artifact.id);
      indexArtifactMessage(path, SESSION, artifact);
    }

    const page = await indexedMessagePage(path, SESSION, { limit: 20 });
    expect(page.messages.map((m) => (m as { artifactId?: string }).artifactId)).toEqual(ids);

    // Offsets must be plain ascending integers for new rows.
    // Re-read via a second page call after sync keeps order.
    const again = await indexedMessagePage(path, SESSION, { limit: 20 });
    expect(again.messages.map((m) => m.id)).toEqual(ids.map((id) => `artifact-${id}`));
  });

  test("html re-publish updates the same ordered row", async () => {
    const path = sessionIndexKey(SESSION);
    const first = publishHtmlArtifact({
      sessionId: SESSION,
      id: "dash-join",
      html: "<!doctype html><html><body>v1</body></html>",
      title: "Dash",
    });
    indexArtifactMessage(path, SESSION, first);

    const second = publishHtmlArtifact({
      sessionId: SESSION,
      id: "dash-join",
      html: "<!doctype html><html><body>v2</body></html>",
      title: "Dash",
    });
    expect(syncArtifactIndex(second)).toBe(0);

    const page = await indexedMessagePage(path, SESSION, { limit: 20 });
    expect(page.messages).toHaveLength(1);
    const msg = page.messages[0] as { kind: string; version?: number; artifactId?: string };
    expect(msg.kind).toBe("html");
    expect(msg.artifactId).toBe("dash-join");
    expect(msg.version).toBe(2);
  });

  test("removeIndexedArtifact drops both joined tables", async () => {
    const source = join(root, "gone.png");
    writeFileSync(source, "x");
    const artifact = createImageArtifact({ sessionId: SESSION, path: source });
    const path = sessionIndexKey(SESSION);
    indexArtifactMessage(path, SESSION, artifact);
    // Durable store + index must both go, or the next page read would backfill.
    deleteArtifact({ id: artifact.id, sessionId: SESSION });
    removeIndexedArtifact(artifact.id);
    const page = await indexedMessagePage(path, SESSION, { limit: 20 });
    expect(page.messages).toHaveLength(0);
  });
});
