#!/usr/bin/env bash
#
# Cut a release in one step: bump the version, verify the CHANGELOG entry,
# commit, tag, push, then build + publish the bundle via scripts/release.sh.
#
# Usage:
#   scripts/tag-release.sh            # patch bump (0.1.36 -> 0.1.37)
#   scripts/tag-release.sh minor      # 0.1.36 -> 0.2.0
#   scripts/tag-release.sh major      # 0.1.36 -> 1.0.0
#
# Preconditions (enforced):
#   - on main, clean tree, in sync with origin/main
#   - CHANGELOG.md already contains an entry mentioning the NEW version
#     (write the release notes first; this script will not invent them)
#
# Env:
#   DRY_RUN=1       do everything except commit/tag/push/publish
#   SKIP_PUBLISH=1  commit+tag+push but skip release.sh (bundle/GH release)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

BUMP="${1:-patch}"
case "$BUMP" in patch|minor|major) ;; *) die "Unknown bump type: $BUMP (use patch|minor|major)";; esac

# --- Preconditions ---------------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "Releases are tagged from main (currently on $BRANCH)."
[ -z "$(git status --porcelain)" ] || die "Working tree is not clean."
git fetch origin main --tags --quiet
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "main is not in sync with origin/main (pull/push first)."

CURRENT="$(bun -e 'console.log(JSON.parse(require("node:fs").readFileSync("package.json","utf8")).version)')"
IFS=. read -r MAJ MIN PAT <<<"$CURRENT"
case "$BUMP" in
  patch) NEXT="$MAJ.$MIN.$((PAT + 1))" ;;
  minor) NEXT="$MAJ.$((MIN + 1)).0" ;;
  major) NEXT="$((MAJ + 1)).0.0" ;;
esac
TAG="v$NEXT"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "Tag $TAG already exists."
grep -q "($TAG)" CHANGELOG.md \
  || die "CHANGELOG.md has no entry for ($TAG). Write the release notes first."

COMMITS="$(git rev-list "v$CURRENT"..HEAD --count 2>/dev/null || echo '?')"
say "Releasing $TAG (from v$CURRENT, $COMMITS commits)."

if [ "${DRY_RUN:-}" = "1" ]; then
  say "DRY_RUN=1 - stopping before any writes."
  exit 0
fi

# --- Bump + commit + tag + push --------------------------------------------
NEXT="$NEXT" bun -e '
const fs = require("node:fs");
const json = JSON.parse(fs.readFileSync("package.json", "utf8"));
json.version = process.env.NEXT;
fs.writeFileSync("package.json", JSON.stringify(json, null, 2) + "\n");
'
bun install --frozen-lockfile >/dev/null 2>&1 || true  # refresh lock metadata if needed
git add package.json CHANGELOG.md bun.lock package-lock.json 2>/dev/null || true
git commit -m "chore: release $TAG"
git tag -a "$TAG" -m "$TAG"
git push origin main "$TAG"
say "Tagged and pushed $TAG."

# --- Build + publish bundle --------------------------------------------------
if [ "${SKIP_PUBLISH:-}" = "1" ]; then
  say "SKIP_PUBLISH=1 - skipping bundle build/publish."
  exit 0
fi
say "Building and publishing the bundle..."
"$ROOT/scripts/release.sh" "$TAG"
