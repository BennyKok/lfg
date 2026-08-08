// Which release asset an install reaches for, and whether it then re-resolves
// dependencies it was just handed.
//
// The fast path only works if two files agree on a filename. release.sh writes
// `omg-<os>-<arch>.tar.gz`; setup.sh asks for whatever platform_asset() spells.
// If those drift, nothing breaks loudly — every install just 404s the platform
// bundle, silently falls back to the neutral one, and pays for a ~2GB
// target-side resolve that the platform bundle existed to avoid. So the naming
// is pinned here as a contract between the two scripts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETUP_SH, extractFunctionSource } from "./setup-script-helpers.ts";

const RELEASE_SH = join(import.meta.dir, "..", "scripts", "release.sh");

/** Run platform_asset() with uname stubbed to a given OS/machine. */
function platformAsset(unameS: string, unameM: string): string {
  const script = [
    "set -euo pipefail",
    `OS_NAME=${JSON.stringify(unameS)}`,
    `uname() { if [ "\${1:-}" = "-m" ]; then printf '%s' ${JSON.stringify(unameM)}; else printf '%s' ${JSON.stringify(unameS)}; fi; }`,
    'die() { printf "DIE:%s" "$*"; exit 3; }',
    extractFunctionSource("platform_asset"),
    "platform_asset",
  ].join("\n");
  const result = Bun.spawnSync(["bash", "-c", script]);
  return new TextDecoder().decode(result.stdout).trim();
}

describe("platform asset naming", () => {
  test("matches the omg-<os>-<arch> shape release.sh publishes", () => {
    expect(platformAsset("Linux", "x86_64")).toBe("omg-linux-x64.tar.gz");
    expect(platformAsset("Linux", "aarch64")).toBe("omg-linux-arm64.tar.gz");
    expect(platformAsset("Darwin", "arm64")).toBe("omg-darwin-arm64.tar.gz");
    expect(platformAsset("Darwin", "x86_64")).toBe("omg-darwin-x64.tar.gz");
  });

  test("common architecture aliases resolve to the same asset", () => {
    expect(platformAsset("Linux", "amd64")).toBe("omg-linux-x64.tar.gz");
    expect(platformAsset("Linux", "arm64")).toBe("omg-linux-arm64.tar.gz");
  });

  // The contract: every platform setup.sh can ask for is a platform release.sh
  // actually builds, and both spell it identically.
  test("every asset setup.sh requests is one release.sh publishes", () => {
    const release = readFileSync(RELEASE_SH, "utf8");
    const platforms = release.match(/LFG_RELEASE_PLATFORMS:-([^}]+)}/);
    expect(platforms, "default platform list not found in release.sh").not.toBeNull();
    const built = platforms![1].trim().split(/\s+/);
    expect(built.length).toBeGreaterThan(0);

    const assetPattern = release.match(/platform_asset="([^"]+)"/);
    expect(assetPattern, "platform asset name not found in release.sh").not.toBeNull();
    // release.sh interpolates ${platform}; reproduce that for each target.
    const published = new Set(
      built.map(platform => assetPattern![1].replace("${platform}", platform)),
    );

    for (const [unameS, unameM, platform] of [
      ["Linux", "x86_64", "linux-x64"],
      ["Linux", "aarch64", "linux-arm64"],
      ["Darwin", "x86_64", "darwin-x64"],
      ["Darwin", "arm64", "darwin-arm64"],
    ] as const) {
      expect(built).toContain(platform);
      expect(published).toContain(platformAsset(unameS, unameM));
    }
  });
});

describe("asset preference", () => {
  const source = readFileSync(SETUP_SH, "utf8");

  test("the platform bundle is tried before the neutral one", () => {
    // Matched by line, not by a paren-balanced regex: the candidate list
    // contains "$(platform_asset)", whose own ")" ends a naive [^)]* match.
    const fallbackList = source
      .split("\n")
      .find(line => line.includes("ASSET_CANDIDATES=(") && line.includes("omg-bundle.tar.gz"));
    expect(fallbackList, "fallback ASSET_CANDIDATES not found in scripts/setup.sh").toBeDefined();
    const platformAt = fallbackList!.indexOf("platform_asset");
    const neutralAt = fallbackList!.indexOf("omg-bundle.tar.gz");
    const legacyAt = fallbackList!.indexOf("lfg-bundle.tar.gz");
    expect(platformAt).toBeGreaterThanOrEqual(0);
    expect(platformAt).toBeLessThan(neutralAt);
    // The pre-rename name must stay last, not disappear: an older pinned tag
    // only has that asset.
    expect(neutralAt).toBeLessThan(legacyAt);
  });

  test("an explicit LFG_RELEASE_ASSET is not second-guessed", () => {
    expect(source).toContain('ASSET_CANDIDATES=("$LFG_RELEASE_ASSET")');
  });
});

describe("skipping the target-side install", () => {
  const source = readFileSync(SETUP_SH, "utf8");

  // Re-resolving on top of a bundle that already shipped node_modules would
  // re-download the musl builds the prune removed, undoing the whole point.
  test("dependencies that shipped with the bundle are not reinstalled", () => {
    expect(source).toContain('Dependencies shipped with $ASSET - skipping install.');
    const guard = source.match(/elif \[ -d "\$LFG_DIR\/node_modules" \][^\n]*\n/);
    expect(guard, "node_modules presence check not found").not.toBeNull();
    // Presence alone is not enough — an empty directory must still install.
    expect(guard![0]).toContain("ls -A");
  });

  test("an install with no dependencies still resolves them", () => {
    expect(source).toContain('"$BUN_BIN" install --production');
  });
});
