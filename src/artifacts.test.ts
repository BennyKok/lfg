import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  collapseArtifactRetryMessages,
  createImageArtifact,
  deleteArtifact,
  getImageArtifact,
  publishHtmlArtifact,
  updateHtmlArtifactRefresh,
  type ArtifactRefreshConfig,
} from "./artifacts.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function refreshConfig(scopeRoot: string): ArtifactRefreshConfig {
  return {
    scriptPath: join(scopeRoot, "refresh.sh"),
    argv: [],
    scopeRoot,
    intervalMs: 10_000,
    timeoutMs: 2_000,
    enabled: true,
    configuredAt: 1,
    status: "idle",
  };
}

describe("artifact display retry reconciliation", () => {
  test("collapses an identical media retry while preserving transcript order", () => {
    const messages = [
      { id: "text-1", kind: "text", ts: 1, text: "before" },
      { id: "artifact-a", kind: "image", ts: 10_000, name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" },
      { id: "artifact-b", kind: "image", ts: 30_000, name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" },
      { id: "text-2", kind: "text", ts: 40_000, text: "after" },
    ];

    expect(collapseArtifactRetryMessages(messages).map((message) => message.id)).toEqual([
      "text-1",
      "artifact-a",
      "text-2",
    ]);
  });

  test("keeps a deliberate later display and distinct media", () => {
    const base = { kind: "image", name: "shot.png", mimeType: "image/png", size: 42, caption: "Live" };
    const messages = [
      { ...base, id: "artifact-a", ts: 10_000 },
      { ...base, id: "artifact-b", ts: 400_001 },
      { ...base, id: "artifact-c", ts: 410_000, size: 43 },
    ];

    expect(collapseArtifactRetryMessages(messages).map((message) => message.id)).toEqual([
      "artifact-a",
      "artifact-b",
      "artifact-c",
    ]);
  });
});

describe("stable HTML artifact ownership", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-artifact-ownership-"));
    PATHS.data = join(root, "data");
  });

  afterEach(() => {
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("a new session takes over an HTML id without breaking its version chain", () => {
    const originalRefresh = refreshConfig(join(root, "session-a"));
    const before = publishHtmlArtifact({
      sessionId: SESSION_A,
      id: "shared-dash",
      html: "<!doctype html><html><body>session A</body></html>",
      refresh: originalRefresh,
    });

    const after = publishHtmlArtifact({
      sessionId: SESSION_B,
      id: "shared-dash",
      html: "<!doctype html><html><body>session B</body></html>",
    });

    expect(after.sessionId).toBe(SESSION_B);
    expect(after.version).toBe(2);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.filePath).toBe(before.filePath);
    expect(after.refresh).toEqual(originalRefresh);
    expect(readFileSync(after.filePath, "utf8")).toContain("session B");

    const reboundRefresh = refreshConfig(join(root, "session-b"));
    expect(() => updateHtmlArtifactRefresh({
      id: after.id,
      sessionId: SESSION_A,
      refresh: reboundRefresh,
    })).toThrow("different session");
    expect(() => deleteArtifact({ id: after.id, sessionId: SESSION_A })).toThrow("different session");

    expect(updateHtmlArtifactRefresh({
      id: after.id,
      sessionId: SESSION_B,
      refresh: reboundRefresh,
    }).refresh).toEqual(reboundRefresh);
    expect(deleteArtifact({ id: after.id, sessionId: SESSION_B }).id).toBe(after.id);
    expect(getImageArtifact(after.id)).toBeNull();
  });

  test("an HTML publish cannot take over an image artifact id", () => {
    const source = join(root, "image.png");
    writeFileSync(source, "not-a-real-png");
    const image = createImageArtifact({ sessionId: SESSION_A, path: source });

    expect(() => publishHtmlArtifact({
      sessionId: SESSION_B,
      id: image.id,
      html: "<!doctype html><html><body>collision</body></html>",
    })).toThrow("different media kind");
    expect(getImageArtifact(image.id)?.media).toBe("image");
  });
});
