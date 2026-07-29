import { readFileSync, writeFileSync } from "node:fs";

type PackageManifest = Record<string, unknown> & {
  workspaces?: unknown;
};

export function prepareReleaseManifest(
  manifest: PackageManifest,
): PackageManifest {
  const { workspaces: _workspaces, ...runtimeManifest } = manifest;
  return runtimeManifest;
}

if (import.meta.main) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("Usage: prepare-release-manifest.ts <package.json>");
  }

  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as PackageManifest;
  writeFileSync(
    manifestPath,
    `${JSON.stringify(prepareReleaseManifest(manifest), null, 2)}\n`,
  );
}
