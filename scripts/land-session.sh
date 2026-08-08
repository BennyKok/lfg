#!/usr/bin/env bash
#
# Serialize an LFG session branch onto origin/main, sync the dedicated local
# main checkout, build it, and restart the local service. The deployed revision
# marker is what the Shipped endpoint uses to reject premature completion.

set -euo pipefail

die() {
  printf '[x] %s\n' "$*" >&2
  exit 1
}

say() {
  printf '==> %s\n' "$*"
}

# A web build that emits index.html but loses its asset chunks still leaves a
# checkout that looks deployable: the service starts, `/` answers 200, and the
# marker below would certify the revision as live while every visitor gets a
# blank page. That has happened (an interrupted/concurrent `vite build` left
# web/dist/assets empty), so refuse to certify a dist whose own entry document
# points at files that are not on disk.
assert_web_bundle_complete() {
  local dist="$MAIN_ROOT/web/dist"
  local index="$dist/index.html"
  [ -f "$index" ] || die "web build produced no $index"

  local missing=0 ref
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    [ -f "$dist/$ref" ] || {
      printf '[x] missing build output: web/dist/%s\n' "$ref" >&2
      missing=1
    }
  done < <(grep -oE '(src|href)="/[^"?#]+"' "$index" | sed -E 's/^[a-z]+="\/(.*)"$/\1/' | sort -u)

  [ "$missing" = "0" ] \
    || die "web/dist is incomplete; rerun the web build (a concurrent or interrupted build can empty web/dist/assets)"
}

# Starting is not serving. Ask the restarted service for the exact entry chunk
# the document loads, so a half-written dist or a stale service can never be
# recorded as the deployed revision.
assert_service_serves_bundle() {
  command -v curl >/dev/null 2>&1 || {
    say "curl unavailable; skipping the served-bundle probe"
    return 0
  }

  local entry
  entry="$(grep -oE 'src="/assets/[^"]+\.js"' "$MAIN_ROOT/web/dist/index.html" | head -1 | sed -E 's/^src="(.*)"$/\1/')"
  [ -n "$entry" ] || die "could not find the entry script in web/dist/index.html"

  local port="${LFG_PORT:-}"
  if [ -z "$port" ] && [ -f "$MAIN_ROOT/.env" ]; then
    port="$(sed -nE 's/^[[:space:]]*LFG_PORT=[[:space:]]*"?([0-9]+)"?.*/\1/p' "$MAIN_ROOT/.env" | tail -1)"
  fi
  port="${port:-8766}"
  local base="${LFG_LAND_PROBE_URL:-http://127.0.0.1:$port}"

  local attempt code
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$base$entry" || true)"
    [ "$code" = "200" ] && {
      say "Served bundle verified at $base$entry"
      return 0
    }
    sleep 1
  done
  die "the restarted service does not serve $entry (last status ${code:-none}); the deployment is not live"
}

SESSION_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" \
  || die "run this from an LFG session worktree"
COMMON_DIR="$(git -C "$SESSION_ROOT" rev-parse --git-common-dir)"
case "$COMMON_DIR" in
  /*) ;;
  *) COMMON_DIR="$(cd "$SESSION_ROOT" && cd "$COMMON_DIR" && pwd)" ;;
esac

MAIN_ROOT="$(
  git -C "$SESSION_ROOT" worktree list --porcelain |
    awk '
      $1 == "worktree" { path = substr($0, 10) }
      $0 == "branch refs/heads/main" { print path; exit }
    '
)"
[ -n "$MAIN_ROOT" ] || die "could not find the main worktree"
[ "$SESSION_ROOT" != "$MAIN_ROOT" ] || die "run this from the isolated session worktree, not main"

# Serialize landings repo-wide. `flock` is util-linux and absent on macOS, where
# the script died with "flock: command not found" before touching anything.
#
# macOS ships BSD `lockf` instead, but only its command-wrapping form is usable:
# its fd form (`lockf 9`) takes a per-process lock that is dropped the moment
# lockf exits, so the shell is left holding nothing. Linux `flock 9` works
# because the lock lives on the open file description the shell shares with it.
#
# So re-exec the whole script under whichever locker exists and let it own the
# lock for our lifetime — which also keeps flock's release-on-death behaviour on
# both platforms. LFG_LAND_LOCK_HELD stops the re-exec recursing; everything
# above this point is read-only git plumbing, so running it twice is harmless.
LAND_LOCK="$COMMON_DIR/lfg-land.lock"
if [ -z "${LFG_LAND_LOCK_HELD:-}" ]; then
  if command -v flock >/dev/null 2>&1; then
    exec env LFG_LAND_LOCK_HELD=1 flock "$LAND_LOCK" "$0" "$@"
  elif command -v lockf >/dev/null 2>&1; then
    exec env LFG_LAND_LOCK_HELD=1 lockf -k "$LAND_LOCK" "$0" "$@"
  else
    die "need flock (util-linux) or lockf (BSD/macOS) to serialize landing"
  fi
fi

[ -z "$(git -C "$SESSION_ROOT" status --porcelain)" ] \
  || die "session worktree has uncommitted changes; commit them first"
[ -z "$(git -C "$MAIN_ROOT" status --porcelain)" ] \
  || die "local main checkout is dirty; preserve or finish those changes before landing"
[ "$(git -C "$MAIN_ROOT" branch --show-current)" = "main" ] \
  || die "local deployment checkout is not on main"

say "Refreshing main under the repository landing lock"
git -C "$SESSION_ROOT" fetch --quiet origin main
git -C "$MAIN_ROOT" merge --ff-only origin/main
[ "$(git -C "$MAIN_ROOT" rev-parse HEAD)" = "$(git -C "$MAIN_ROOT" rev-parse origin/main)" ] \
  || die "local main contains unpushed commits; land or preserve them before this session"

# The web build runs `tsc --noEmit` as part of `bun run build`, so a type error
# under web/ has always blocked a landing. Nothing ran the equivalent for the
# BACKEND: `bun run typecheck` existed in package.json but no gate — not CI
# (only audit + release workflows), not this script — ever invoked it. src/ was
# therefore free to drift red indefinitely, and did: two errors in serve.ts sat
# on main undetected because a deploy only ever exercises the web bundle.
#
# Gate before the push, not after, so a type error is something you fix in your
# own worktree instead of something the next person inherits from main.
if [ "${LFG_LAND_SKIP_TYPECHECK:-0}" != "1" ]; then
  say "Typechecking the backend"
  (cd "$SESSION_ROOT" && bun run typecheck) \
    || die "backend typecheck failed; fix it before landing (LFG_LAND_SKIP_TYPECHECK=1 to override)"
fi

landed=0
for attempt in 1 2 3; do
  git -C "$SESSION_ROOT" fetch --quiet origin main
  if ! git -C "$SESSION_ROOT" rebase origin/main; then
    git -C "$SESSION_ROOT" rebase --abort >/dev/null 2>&1 || true
    die "session conflicts with current main; resolve the rebase manually, then rerun"
  fi
  if git -C "$SESSION_ROOT" push origin HEAD:main; then
    landed=1
    break
  fi
  say "Main advanced during push; retrying on the new origin/main ($attempt/3)"
done
[ "$landed" = "1" ] || die "origin/main kept advancing; rerun the landing command"

say "Syncing and building the local main checkout"
git -C "$MAIN_ROOT" fetch --quiet origin main
git -C "$MAIN_ROOT" merge --ff-only origin/main
if [ "${LFG_LAND_SKIP_BUILD:-0}" != "1" ]; then
  (cd "$MAIN_ROOT" && bun install --frozen-lockfile)
  (cd "$MAIN_ROOT/web" && bun install --frozen-lockfile)
  # The web workspace resolves @lfg-dev/* through each package's generated
  # dist entrypoint. Rebuild those entrypoints first so a transport/protocol
  # source change cannot make the web build consume stale declarations.
  (cd "$MAIN_ROOT" && bun run --cwd packages/protocol build)
  (cd "$MAIN_ROOT" && bun run --cwd packages/client build)
  (cd "$MAIN_ROOT" && bun run --cwd packages/react build)
  (cd "$MAIN_ROOT/web" && bun run build)
fi

# Checked even when the build is skipped: reusing an existing web/dist is
# exactly the case where the on-disk bundle can already be gutted.
assert_web_bundle_complete

deployed_head="$(git -C "$MAIN_ROOT" rev-parse HEAD)"
if [ "${LFG_LAND_SKIP_RESTART:-0}" != "1" ]; then
  # Resolve the unit rather than assuming one. A box installed after the OMG
  # rename runs omg.service, and restarting a hardcoded lfg.service there would
  # fail the `is-active` check below at best — or, if the old unit still exists
  # alongside the new one, certify a deploy having restarted the wrong process.
  if [ -n "${OMG_SERVICE_NAME:-${LFG_SERVICE_NAME:-}}" ]; then
    service_name="${OMG_SERVICE_NAME:-$LFG_SERVICE_NAME}"
  elif [ -f "$HOME/.config/systemd/user/omg.service" ]; then
    service_name="omg.service"
  else
    service_name="lfg.service"
  fi
  say "Restarting $service_name at $deployed_head"
  systemctl --user restart "$service_name"
  systemctl --user is-active --quiet "$service_name" \
    || die "$service_name did not become active"
  assert_service_serves_bundle
fi

marker="$COMMON_DIR/lfg-deployed-head"
temp_marker="$marker.$$.tmp"
printf '%s\n' "$deployed_head" >"$temp_marker"
mv "$temp_marker" "$marker"
say "Landed and deployed $deployed_head"
