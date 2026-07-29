#!/usr/bin/env bash
#
# Build the public LFG packages and, unless --build-only is passed, pack
# release-ready tarballs. Internal workspace dependencies are rewritten to the
# immutable GitHub release assets for this exact LFG version, so consumers do
# not need a private registry or a moving git branch.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/dist"
REPO_SLUG="${LFG_REPO_SLUG:-BennyKok/lfg}"
VERSION="$(bun -e 'console.log(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version)')"
PACKAGES=(protocol client react)

if [ "${SKIP_PACKAGE_BUILD:-}" != "1" ]; then
  for package in "${PACKAGES[@]}"; do
    bun run --cwd "packages/$package" build
  done
  bun run --cwd web build:lib
fi

if [ "${1:-}" = "--build-only" ]; then
  exit 0
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/lfg-dev-*.tgz
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lfg-packages.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

for package in "${PACKAGES[@]}"; do
  package_stage="$STAGE/$package"
  mkdir -p "$package_stage"
  cp -r "packages/$package/dist" "$package_stage/dist"
  cp "packages/$package/package.json" "$package_stage/package.json"
  cp LICENSE "$package_stage/LICENSE"

  MANIFEST="$package_stage/package.json" \
  VERSION="$VERSION" \
  REPO_SLUG="$REPO_SLUG" \
  bun -e '
const fs = require("node:fs");
const manifest = process.env.MANIFEST;
const version = process.env.VERSION;
const repo = process.env.REPO_SLUG;
const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
json.version = version;
for (const section of ["dependencies", "optionalDependencies"]) {
  for (const [name, value] of Object.entries(json[section] || {})) {
    if (!name.startsWith("@lfg-dev/") || value !== "workspace:*") continue;
    const short = name.slice("@lfg-dev/".length);
    json[section][name] =
      `https://github.com/${repo}/releases/download/v${version}/lfg-dev-${short}-${version}.tgz`;
  }
}
delete json.scripts;
delete json.devDependencies;
fs.writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
'

  npm pack "$package_stage" --pack-destination "$OUT_DIR" --silent
done

app_stage="$STAGE/app"
mkdir -p "$app_stage"
cp -r web/dist-lib "$app_stage/dist-lib"
cp web/package.json "$app_stage/package.json"
cp LICENSE "$app_stage/LICENSE"

MANIFEST="$app_stage/package.json" \
VERSION="$VERSION" \
REPO_SLUG="$REPO_SLUG" \
bun -e '
const fs = require("node:fs");
const manifest = process.env.MANIFEST;
const version = process.env.VERSION;
const repo = process.env.REPO_SLUG;
const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
json.version = version;
for (const section of ["dependencies", "optionalDependencies"]) {
  for (const [name, value] of Object.entries(json[section] || {})) {
    if (!name.startsWith("@lfg-dev/") || value !== "workspace:*") continue;
    const short = name.slice("@lfg-dev/".length);
    json[section][name] =
      `https://github.com/${repo}/releases/download/v${version}/lfg-dev-${short}-${version}.tgz`;
  }
}
delete json.scripts;
delete json.devDependencies;
fs.writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
'

npm pack "$app_stage" --pack-destination "$OUT_DIR" --silent
