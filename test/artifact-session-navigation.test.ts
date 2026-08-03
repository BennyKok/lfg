import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("artifact session navigation", () => {
  const app = readFileSync("web/src/App.tsx", "utf8");
  const gallery = readFileSync("web/src/views/shipped-page.tsx", "utf8");
  const server = readFileSync("src/commands/serve.ts", "utf8");

  test("gallery artifacts expose a discoverable related-session action", () => {
    expect(gallery).toContain("Open related session for");
    expect(gallery).toContain("onOpenArtifactSession?.(a)");
    expect(gallery).toContain("a.sessionTitle || a.project || \"Related session\"");
  });

  test("artifact ownership metadata reaches the historical session reviewer", () => {
    expect(server).toContain("sessionStartedAt: managedBySession.get(artifact.sessionId)?.createdAt");
    expect(app).toContain("onOpenArtifactSession={openArtifactSession}");
    expect(app).toContain('reviewLabel: "Artifact"');
    expect(app).toContain("openHistoricalSession({");
  });
});
