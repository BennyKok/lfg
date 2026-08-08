#!/usr/bin/env bash
#
# Build (and optionally publish) an lfg release bundle LOCALLY.
#
# The bundle ships source, the prebuilt web UI, and optional tarballs for
# unpublished/private packages. Public dependencies are installed on the target
# machine so native/optional packages resolve for that OS.
#
# Usage:
#   scripts/release.sh                 # build dist/omg-bundle.tar.gz only
#   scripts/release.sh v0.1.0          # build AND publish a GitHub release (gh)
#   SKIP_INSTALL=1 scripts/release.sh  # reuse the current node_modules / web/dist
#
# Env:
#   SKIP_INSTALL=1        skip `bun install` + web build (use the tree as-is)
#   LFG_REPO_SLUG         GitHub owner/repo to publish to (default: BennyKok/omg.dev)
#   LFG_VENDOR_PACKAGES   space/comma-separated package names to pack from
#                         node_modules into vendor/*.tgz, and rewrite staged
#                         package.json deps to file:vendor/<tarball>.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="$ROOT/dist"
REPO_SLUG="${LFG_REPO_SLUG:-BennyKok/omg.dev}"
VERSION="${1:-}"
ASSET="${LFG_RELEASE_ASSET:-omg-bundle.tar.gz}"
# The pre-rename asset name, published alongside the new one. Every setup.sh
# already downloaded onto a machine asks for lfg-bundle.tar.gz by name, so the
# day this stops being published is the day every existing installer breaks on
# `latest`. Same bytes, same checksum, two names.
LEGACY_ASSET="lfg-bundle.tar.gz"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v bun >/dev/null || die "bun not found on PATH."
command -v tar >/dev/null || die "tar not found on PATH."

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to write the checksum."
  fi
}

pkg_dir() {
  printf '%s/node_modules/%s' "$ROOT" "$1"
}

rewrite_dep_to_vendor_tarball() {
  local manifest="$1"
  local pkg="$2"
  local tarball="$3"
  PKG_NAME="$pkg" TARBALL="vendor/$tarball" MANIFEST="$manifest" bun -e '
const fs = require("node:fs");
const manifest = process.env.MANIFEST;
const pkg = process.env.PKG_NAME;
const tarball = process.env.TARBALL;
const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
let found = false;
for (const section of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
  if (json[section] && Object.prototype.hasOwnProperty.call(json[section], pkg)) {
    json[section][pkg] = `file:${tarball}`;
    found = true;
  }
}
if (!found) {
  if (!json.dependencies) json.dependencies = {};
  json.dependencies[pkg] = `file:${tarball}`;
}
fs.writeFileSync(manifest, JSON.stringify(json, null, 2) + "\n");
'
}

if [ "${SKIP_INSTALL:-}" != "1" ]; then
  say "Installing dependencies (uses your configured registry)..."
  bun install
  say "Building public packages..."
  bun run build:packages
  say "Building the web UI..."
  bun run --cwd web build
else
  say "SKIP_INSTALL=1 - reusing existing node_modules + web/dist."
fi

say "Building public packages..."
SKIP_PACKAGE_BUILD=1 bash scripts/pack-packages.sh

[ -f web/dist/index.html ] || die "web/dist missing - run without SKIP_INSTALL."

# Stage exactly what the runtime needs. Public deps are intentionally not
# included; setup.sh runs a target-side production install after extracting.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lfg-release.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/lfg/web" "$STAGE/lfg/vendor"
say "Staging bundle..."
cp -r \
  src agents scripts package.json bun.lock tsconfig.json \
  .env.example README.md CHANGELOG.md LICENSE SECURITY.md CONTRIBUTING.md \
  "$STAGE/lfg/"
cp -r web/dist "$STAGE/lfg/web/dist"
bun run scripts/prepare-release-manifest.ts "$STAGE/lfg/package.json"

VENDOR_PACKAGES="${LFG_VENDOR_PACKAGES:-}"
VENDOR_PACKAGES="${VENDOR_PACKAGES//,/ }"
if [ -n "$VENDOR_PACKAGES" ]; then
  command -v npm >/dev/null || die "npm is required to pack LFG_VENDOR_PACKAGES."
  [ -d node_modules ] || die "node_modules missing - run without SKIP_INSTALL so vendor packages can be packed."
  say "Packing vendor packages..."
  for pkg in $VENDOR_PACKAGES; do
    dir="$(pkg_dir "$pkg")"
    [ -d "$dir" ] || die "Vendor package $pkg not found at $dir. Run bun install first."
    packed="$(npm pack "$dir" --pack-destination "$STAGE/lfg/vendor" --silent)"
    packed="$(basename "$packed")"
    say "  $pkg -> vendor/$packed"
    rewrite_dep_to_vendor_tarball "$STAGE/lfg/package.json" "$pkg" "$packed"
  done
else
  rmdir "$STAGE/lfg/vendor"
fi

# The source lockfile also records workspaces that are intentionally absent from
# the runtime bundle. Generate a bundle-owned production lockfile from the
# staged manifest so target installs cannot resolve an impossible workspace.
rm "$STAGE/lfg/bun.lock"
( cd "$STAGE/lfg" && unset CI && bun install --production --lockfile-only )

mkdir -p "$OUT_DIR"
say "Packing ${ASSET}..."
tar -C "$STAGE" -czf "$OUT_DIR/$ASSET" lfg
( cd "$OUT_DIR" && printf '%s  %s\n' "$(sha256_file "$ASSET")" "$ASSET" > "$ASSET.sha256" )

if [ "$ASSET" != "$LEGACY_ASSET" ]; then
  cp "$OUT_DIR/$ASSET" "$OUT_DIR/$LEGACY_ASSET"
  ( cd "$OUT_DIR" && printf '%s  %s\n' "$(sha256_file "$LEGACY_ASSET")" "$LEGACY_ASSET" > "$LEGACY_ASSET.sha256" )
fi

SIZE="$(du -h "$OUT_DIR/$ASSET" | cut -f1)"
say "Built $OUT_DIR/$ASSET ($SIZE)"
cat "$OUT_DIR/$ASSET.sha256"

# ---- per-platform bundles -------------------------------------------------
# The neutral bundle above ships no dependencies, so every install resolves the
# graph itself and pulls ~2GB - including musl builds that cannot execute on a
# glibc host, because Bun filters optionalDependencies by os and cpu but not by
# libc. These bundles carry node_modules already installed and pruned for one
# target, which is what lets setup.sh skip `bun install` entirely.
PLATFORM_ASSETS=()
PLATFORMS="${LFG_RELEASE_PLATFORMS:-linux-x64 linux-arm64 darwin-x64 darwin-arm64}"
if [ "${LFG_SKIP_PLATFORM_BUNDLES:-0}" = "1" ]; then
  say "LFG_SKIP_PLATFORM_BUNDLES=1 - neutral bundle only."
  PLATFORMS=""
fi
for platform in $PLATFORMS; do
  target_os="${platform%-*}"
  target_cpu="${platform#*-}"
  # musl targets would want the mirror-image prune; setup.sh requires apt-get or
  # Homebrew, so every bundle we publish is a glibc/darwin one.
  pstage="$(mktemp -d "${TMPDIR:-/tmp}/lfg-platform.XXXXXX")"
  say "Building platform bundle ${platform}..."
  cp -a "$STAGE/lfg" "$pstage/lfg"
  if ! ( cd "$pstage/lfg" && unset CI && bun install --production \
           --os="$target_os" --cpu="$target_cpu" >/dev/null 2>&1 ); then
    printf '\033[1;33m[!]\033[0m %s\n' "bun install failed for $platform - skipping that bundle." >&2
    rm -rf "$pstage"
    continue
  fi
  # Drop the agent runtimes the SDKs bundle - whole coding-agent binaries, about
  # 1GB of the tree, shipped only as a fallback for machines that lack the CLI.
  # Every backend already prefers the user's own binary, and a hosted image adds
  # them on top of this same bundle with OMG_INSTALL_CLAUDE=1 / _OPENCODE=1.
  # Set LFG_BUNDLE_AGENT_RUNTIMES=1 to build the heavy variant anyway.
  drop_agents="--drop-agent-runtimes"
  [ "${LFG_BUNDLE_AGENT_RUNTIMES:-0}" = "1" ] && drop_agents=""
  # shellcheck disable=SC2086
  bun run "$ROOT/scripts/prune-modules.ts" \
    --root "$pstage/lfg/node_modules" \
    --os "$target_os" --cpu "$target_cpu" --libc glibc --quiet $drop_agents
  platform_asset="omg-${platform}.tar.gz"
  tar -C "$pstage" -czf "$OUT_DIR/$platform_asset" lfg
  ( cd "$OUT_DIR" && printf '%s  %s\n' "$(sha256_file "$platform_asset")" "$platform_asset" \
      > "$platform_asset.sha256" )
  say "  $platform_asset ($(du -h "$OUT_DIR/$platform_asset" | cut -f1))"
  PLATFORM_ASSETS+=("$OUT_DIR/$platform_asset" "$OUT_DIR/$platform_asset.sha256")
  rm -rf "$pstage"
done

if [ -z "$VERSION" ]; then
  echo
  say "No version given - artifact built but not published."
  say "Publish with:  scripts/release.sh v0.1.0"
  exit 0
fi

command -v gh >/dev/null || die "gh not found - needed to publish."
say "Publishing ${VERSION} to ${REPO_SLUG}..."
if gh release view "$VERSION" --repo "$REPO_SLUG" >/dev/null 2>&1; then
  gh release upload "$VERSION" \
    "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256" \
    "$OUT_DIR/$LEGACY_ASSET" "$OUT_DIR/$LEGACY_ASSET.sha256" \
    "$OUT_DIR"/omg-dev-*.tgz \
    ${PLATFORM_ASSETS+"${PLATFORM_ASSETS[@]}"} \
    --repo "$REPO_SLUG" --clobber
else
  gh release create "$VERSION" \
    "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256" \
    "$OUT_DIR/$LEGACY_ASSET" "$OUT_DIR/$LEGACY_ASSET.sha256" "$OUT_DIR"/omg-dev-*.tgz \
    ${PLATFORM_ASSETS+"${PLATFORM_ASSETS[@]}"} \
    --repo "$REPO_SLUG" --title "$VERSION" --generate-notes
fi
say "Done. Latest-release install URL:"
echo "  https://github.com/$REPO_SLUG/releases/latest/download/$ASSET"
