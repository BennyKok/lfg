import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { prepareReleaseManifest } from "../scripts/prepare-release-manifest";

describe("release bundle manifest", () => {
  test("does not advertise source workspaces that are absent from the bundle", () => {
    const source = {
      name: "lfg",
      workspaces: ["packages/*", "web"],
      dependencies: { zod: "^4.0.0" },
    };

    expect(prepareReleaseManifest(source)).toEqual({
      name: "lfg",
      dependencies: { zod: "^4.0.0" },
    });
  });

  test("the release packer prepares the staged manifest", () => {
    const releaseScript = readFileSync(
      new URL("../scripts/release.sh", import.meta.url),
      "utf8",
    );

    expect(releaseScript).toContain(
      'bun run scripts/prepare-release-manifest.ts "$STAGE/lfg/package.json"',
    );
    expect(releaseScript).toContain(
      '( cd "$STAGE/lfg" && unset CI && bun install --production --lockfile-only )',
    );
  });
});
