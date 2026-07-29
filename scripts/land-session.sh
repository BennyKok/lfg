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

exec 9>"$COMMON_DIR/lfg-land.lock"
flock 9

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
  bun --cwd "$MAIN_ROOT" install --frozen-lockfile
  bun --cwd "$MAIN_ROOT/web" install --frozen-lockfile
  bun --cwd "$MAIN_ROOT/web" run build
fi

deployed_head="$(git -C "$MAIN_ROOT" rev-parse HEAD)"
if [ "${LFG_LAND_SKIP_RESTART:-0}" != "1" ]; then
  service_name="${LFG_SERVICE_NAME:-lfg.service}"
  say "Restarting $service_name at $deployed_head"
  systemctl --user restart "$service_name"
  systemctl --user is-active --quiet "$service_name" \
    || die "$service_name did not become active"
fi

marker="$COMMON_DIR/lfg-deployed-head"
temp_marker="$marker.$$.tmp"
printf '%s\n' "$deployed_head" >"$temp_marker"
mv "$temp_marker" "$marker"
say "Landed and deployed $deployed_head"
