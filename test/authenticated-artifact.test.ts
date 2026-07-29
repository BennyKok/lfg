import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  artifactRequestPath,
  secureArtifactDocument,
} from "../web/src/lib/artifact-document.ts";

describe("authenticated artifacts", () => {
  test("preserves existing query params while adding cache and thumbnail keys", () => {
    expect(
      artifactRequestPath("/api/artifacts/report?mode=compact", {
        v: 42,
        thumb: 1,
      }),
    ).toBe("/api/artifacts/report?mode=compact&v=42&thumb=1");
  });

  test("restores the server sandbox when fetched HTML becomes srcDoc", () => {
    const html = secureArtifactDocument(
      "<!doctype html><html><head><title>Report</title></head><body>ok</body></html>",
    );
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<title>"),
    );
  });

  test("wraps fragments in a complete locked-down document", () => {
    const html = secureArtifactDocument("<main>ok</main>");
    expect(html).toStartWith("<!doctype html><html><head>");
    expect(html).toContain("<body><main>ok</main></body>");
  });

  test("every artifact surface loads through the configured transport", () => {
    const app = readFileSync("web/src/App.tsx", "utf8");
    const component = readFileSync(
      "web/src/components/authenticated-artifact.tsx",
      "utf8",
    );
    const lightbox = readFileSync(
      "web/src/components/ImageLightbox.tsx",
      "utf8",
    );
    expect(component).toContain("lfgFetch(requestPath");
    expect(component).toContain("lfgFetch(path");
    expect(component).toContain("URL.createObjectURL");
    expect(component).toContain("URL.revokeObjectURL(objectUrl)");
    expect(lightbox).toContain('src.startsWith("blob:")');
    expect(app).toContain("<AuthenticatedArtifactFrame");
    expect(app).toContain("<AuthenticatedArtifactImage");
    expect(app).toContain("<AuthenticatedArtifactVideo");
    expect(app).not.toContain("<AutoHeightArtifactFrame key={src} src={src}");
    expect(app).not.toContain("src={message.url}");
    expect(app).not.toContain("src={item.url}");
  });
});
