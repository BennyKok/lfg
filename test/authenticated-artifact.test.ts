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
      "dark",
    );
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("--lfg-artifact-surface:#1c1c1e");
    expect(html).toContain("background:var(--lfg-artifact-surface)");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<title>"),
    );
  });

  test("theme defaults precede authored styles so intentional colors still win", () => {
    const html = secureArtifactDocument(
      "<html><head><style>body{background:hotpink}</style></head><body>ok</body></html>",
      "dark",
    );
    expect(html.indexOf('id="lfg-artifact-theme"')).toBeLessThan(
      html.indexOf("background:hotpink"),
    );
  });

  test("wraps fragments in a complete locked-down document", () => {
    const html = secureArtifactDocument("<main>ok</main>");
    expect(html).toStartWith('<!doctype html><html data-theme="light"><head>');
    expect(html).toContain("<body><main>ok</main></body>");
  });

  test("stamps the card's theme where CSS can select on it", () => {
    // A card is themed by LFG, not the desktop, so an artifact keying dark mode
    // off prefers-color-scheme paints its light branch over dark surfaces.
    const html = secureArtifactDocument(
      '<!doctype html><html lang="en"><head></head><body>ok</body></html>',
      "dark",
    );
    expect(html).toContain('<html lang="en" data-theme="dark">');
  });

  test("does not override a theme the artifact set for itself", () => {
    const html = secureArtifactDocument(
      '<html data-theme="light"><head></head><body>ok</body></html>',
      "dark",
    );
    expect(html).toContain('<html data-theme="light">');
    expect(html).not.toContain('data-theme="dark"');
  });

  test("publishes short aliases for the tokens artifacts reach for", () => {
    const html = secureArtifactDocument("<main>ok</main>", "dark");
    // The near miss is the expensive one: --lfg-artifact-muted is a surface, so
    // text painted with it disappears into its own background.
    expect(html).toContain("--lfg-artifact-muted-fg:rgba(235, 235, 245, 0.6)");
    expect(html).toContain("--lfg-artifact-bg:#000000");
    expect(html).toContain("--lfg-artifact-fg:#ffffff");
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
    const native = readFileSync("web/src/components/native-artifact.tsx", "utf8");
    expect(component).toContain("lfgFetch(path");
    expect(component).toContain("URL.createObjectURL");
    expect(component).toContain("URL.revokeObjectURL(objectUrl)");
    expect(component).toContain("aspectRatio:");
    expect(component).toContain("width={width}");
    expect(component).toContain("height={height}");
    expect(lightbox).toContain('src.startsWith("blob:")');
    expect(app).toContain("<AuthenticatedArtifactImage");
    expect(app).toContain("width={message.width}");
    expect(app).toContain("height={message.height}");
    expect(app).toContain("<AuthenticatedArtifactVideo");
    // HTML artifacts render through the native renderer, which fetches through
    // the transport itself (asserted in native-artifact.test.ts).
    expect(native).toContain("lfgFetch(requestPath");
    expect(app).toMatch(/<NativeArtifact(Embed|Thumbnail)?\b/);
    // The failure this guards: an artifact rendered from a raw URL instead of
    // the transport shows the surrounding Vibes app instead of the artifact.
    expect(app).not.toContain("src={message.url}");
    expect(app).not.toContain("src={item.url}");
    expect(app).not.toContain("srcDoc={");
  });
});
