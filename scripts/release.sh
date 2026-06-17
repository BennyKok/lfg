#!/usr/bin/env bash
#
# Build (and optionally publish) a self-contained lfg release bundle LOCALLY.
#
# Why local: lfg depends on an AI-SDK ("vibes") provider that lives on a private
# custom registry GitHub-hosted runners can't reach. This box already has that
# provider resolved in node_modules, so we build the bundle here and upload it
# straight to a GitHub Release - no registry access needed in CI.
#
# Usage:
#   scripts/release.sh                 # build dist/lfg-bundle.tar.gz only
#   scripts/release.sh v0.1.0          # build AND publish a GitHub release (gh)
#   SKIP_INSTALL=1 scripts/release.sh  # reuse the current node_modules / web/dist
#
# Env:
#   SKIP_INSTALL=1   skip `bun install` + web build (use the tree as-is)
#   LFG_REPO_SLUG    GitHub owner/repo to publish to (default: BennyKok/lfg)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ASSET="lfg-bundle.tar.gz"
OUT_DIR="$ROOT/dist"
REPO_SLUG="${LFG_REPO_SLUG:-BennyKok/lfg}"
VERSION="${1:-}"

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

if [ "${SKIP_INSTALL:-}" != "1" ]; then
  say "Installing dependencies (uses your configured registry)..."
  bun install
  say "Building the web UI..."
  ( cd web && bun install && bun run build )
else
  say "SKIP_INSTALL=1 - reusing existing node_modules + web/dist."
fi

[ -d node_modules ] || die "node_modules missing - run without SKIP_INSTALL."
[ -f web/dist/index.html ] || die "web/dist missing - run without SKIP_INSTALL."

# Stage exactly what the runtime needs (mirrors .github/workflows/release.yml).
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lfg-release.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/lfg/web"
say "Staging bundle..."
cp -r \
  src agents scripts package.json bun.lock tsconfig.json \
  .env.example README.md LICENSE SECURITY.md CONTRIBUTING.md \
  node_modules \
  "$STAGE/lfg/"
cp -r web/dist "$STAGE/lfg/web/dist"

# Drop the vendored agent runtimes entirely - lfg spawns the SYSTEM claude /
# codex / opencode binaries off PATH (LFG_*_PATH -> Bun.which; see the harnesses
# in src/agents/backends/), and scripts/setup.sh installs all three on the box.
# The bundled per-platform binaries were only a fallback; shipping them added
# ~1.3GB. We keep the JS wrappers/providers (claude-agent-sdk, @openai/codex,
# opencode-ai, the ai-sdk-provider-* packages) - only the heavy binary packages
# and dev-only deps are removed.
PRUNE=(
  # Anthropic Claude Code platform binaries
  "@anthropic-ai/claude-agent-sdk-*"
  # OpenAI Codex platform binaries
  "@openai/codex-*"
  # OpenCode platform binaries + the .bin shim into them
  "opencode-linux-*"
  "opencode-darwin-*"
  "opencode-win32-*"
  "opencode-freebsd-*"
  ".bin/opencode"
  # dev-only
  "typescript"
  "bun-types"
  "@types"
)
say "Pruning vendored agent binaries + dev-only packages..."
for p in "${PRUNE[@]}"; do
  for match in "$STAGE/lfg/node_modules"/$p; do
    [ -e "$match" ] && rm -rf "$match"
  done
done

mkdir -p "$OUT_DIR"
say "Packing ${ASSET}..."
tar -C "$STAGE" -czf "$OUT_DIR/$ASSET" lfg
( cd "$OUT_DIR" && printf '%s  %s\n' "$(sha256_file "$ASSET")" "$ASSET" > "$ASSET.sha256" )

SIZE="$(du -h "$OUT_DIR/$ASSET" | cut -f1)"
say "Built $OUT_DIR/$ASSET ($SIZE)"
cat "$OUT_DIR/$ASSET.sha256"

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
    "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256" --repo "$REPO_SLUG" --clobber
else
  gh release create "$VERSION" \
    "$OUT_DIR/$ASSET" "$OUT_DIR/$ASSET.sha256" \
    --repo "$REPO_SLUG" --title "$VERSION" --generate-notes
fi
say "Done. Latest-release install URL:"
echo "  https://github.com/$REPO_SLUG/releases/latest/download/$ASSET"
