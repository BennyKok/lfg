import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("authenticated artifact images", () => {
  test("every artifact image surface loads through the configured transport", () => {
    const app = readFileSync("web/src/App.tsx", "utf8");
    const component = readFileSync(
      "web/src/components/authenticated-artifact.tsx",
      "utf8",
    );
    const lightbox = readFileSync(
      "web/src/components/ImageLightbox.tsx",
      "utf8",
    );

    expect(component).toContain("lfgFetch(path");
    expect(component).toContain("URL.createObjectURL");
    expect(component).toContain("URL.revokeObjectURL(objectUrl)");
    expect(lightbox).toContain('src.startsWith("blob:")');
    expect(app).toContain("<AuthenticatedArtifactImage");
    expect(app).not.toContain('<ZoomableImage\n              src={message.url}');
    expect(app).not.toContain('<ZoomableImage\n      src={item.url}');
  });
});
