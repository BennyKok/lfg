#!/usr/bin/env bash
# lfg-doctor — check a self-hosted lfg box and repair the usual post-crash /
# post-reboot breakage. Safe to run any time; it only acts on what is broken.
#
#   lfg-doctor.sh              check, and repair anything broken
#   lfg-doctor.sh --check      report only, change nothing (exit 1 if unhealthy)
#   lfg-doctor.sh --rebuild    force a web bundle rebuild, then restart
#
# Env:
#   LFG_PORT         port to probe (else .env, else 8766)
#   LFG_PUBLIC_URL   also probe this external URL (else .env, else skipped)
set -uo pipefail

SELF=$(readlink -f "$0")                       # may be invoked via a symlink
REPO=$(cd "$(dirname "$SELF")/.." && pwd)
INDEX="$REPO/web/dist/index.html"
BUILD_LOG=${TMPDIR:-/tmp}/lfg-doctor-build.log

MODE=repair
case "${1:-}" in
  --check)   MODE=check ;;
  --rebuild) MODE=rebuild ;;
  -h|--help) sed -n '2,11p' "$SELF" | sed 's/^# \?//'; exit 0 ;;
  "")        ;;
  *)         echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

# Read a KEY=value out of the repo .env without sourcing it (it holds secrets).
from_env_file() {
  [ -f "$REPO/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$REPO/.env" | tail -1 | tr -d '"'\''' | tr -d '\r'
}

PORT=${LFG_PORT:-$(from_env_file LFG_PORT)}
PORT=${PORT:-8766}
PUBLIC_URL=${LFG_PUBLIC_URL:-$(from_env_file LFG_PUBLIC_URL)}

# lfg runs as the user that owns the checkout. Re-target to that user when this
# is invoked as root, so `systemctl --user` and the build touch the right home.
SVC_USER=$(stat -c %U "$REPO" 2>/dev/null || echo "$USER")
SVC_HOME=$(getent passwd "$SVC_USER" | cut -d: -f6)
SVC_UID=$(id -u "$SVC_USER" 2>/dev/null)

# PATH is set explicitly: vite's shebang is `env node`, and a sudo or systemd
# invocation does not inherit the login PATH that has node and bun on it.
LFG_PATH="$SVC_HOME/.local/bin:$SVC_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
as_svc() {
  if [ "$(id -u)" -eq "${SVC_UID:-0}" ]; then
    env XDG_RUNTIME_DIR="/run/user/$SVC_UID" PATH="$LFG_PATH" "$@"
  else
    sudo -u "$SVC_USER" env XDG_RUNTIME_DIR="/run/user/$SVC_UID" PATH="$LFG_PATH" "$@"
  fi
}
sctl() { as_svc systemctl --user "$@"; }
unit_exists() { sctl cat "$1" >/dev/null 2>&1; }

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
fix()  { printf '  \033[33mfix\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mfail\033[0m  %s\n' "$1"; }
skip() { printf '  \033[90m--\033[0m    %s\n' "$1"; }

http_code() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null; }

# LFG_PUBLIC_URL is usually set in the unit (or a drop-in) rather than .env,
# since serve binds loopback and something else fronts it.
if [ -z "$PUBLIC_URL" ] && unit_exists lfg.service; then
  PUBLIC_URL=$(sctl show lfg.service -p Environment --value 2>/dev/null |
    tr ' ' '\n' | sed -n 's/^LFG_PUBLIC_URL=//p' | tail -1)
fi

REPAIRED=0
FAILED=0

echo "lfg-doctor  ($MODE, $REPO)"

# 1. services ---------------------------------------------------------------
# lfg-connect is optional (relay pairing), so only check it when installed.
echo "services:"
for unit in lfg.service lfg-connect.service; do
  if ! unit_exists "$unit"; then
    [ "$unit" = lfg.service ] && skip "$unit not installed (started by hand?)" \
                              || skip "$unit not installed"
    continue
  fi
  state=$(sctl is-active "$unit" 2>/dev/null)
  if [ "$state" = active ]; then
    ok "$unit active"
  elif [ "$MODE" = check ]; then
    bad "$unit $state"; FAILED=1
  else
    fix "$unit $state → starting"
    sctl restart "$unit" >/dev/null 2>&1
    sleep 3
    if [ "$(sctl is-active "$unit" 2>/dev/null)" = active ]; then
      ok "$unit active"; REPAIRED=1
    else
      bad "$unit still not active — see: journalctl --user -u $unit -n 50"; FAILED=1
    fi
  fi
done

# 2. web bundle -------------------------------------------------------------
# A build killed mid-flight (crash, OOM, reboot) leaves web/dist holding only
# the copied public/ assets — no index.html. The API keeps answering while
# every page load 500s, so this looks like a dead server but isn't.
echo "web bundle:"
build_web() {
  fix "building web/dist (vite only — recovery must not block on WIP type errors)"
  if ( cd "$REPO/web" && as_svc ./node_modules/.bin/vite build ) >"$BUILD_LOG" 2>&1; then
    ok "web/dist rebuilt"
    return 0
  fi
  bad "web build failed — see $BUILD_LOG"
  return 1
}

NEED_BUILD=0
[ -f "$INDEX" ] || NEED_BUILD=1
[ "$MODE" = rebuild ] && NEED_BUILD=1

if [ "$NEED_BUILD" -eq 0 ]; then
  ok "web/dist/index.html present"
elif [ "$MODE" = check ]; then
  bad "web/dist/index.html missing"; FAILED=1
elif build_web; then
  REPAIRED=1
  unit_exists lfg.service && { sctl restart lfg.service >/dev/null 2>&1; sleep 4; }
else
  FAILED=1
fi

# 3. health -----------------------------------------------------------------
echo "health:"
code=$(http_code "http://127.0.0.1:$PORT/")
if [ "$code" != 200 ] && [ "$MODE" != check ] && unit_exists lfg.service; then
  fix "GET / returned $code → restarting lfg.service"
  sctl restart lfg.service >/dev/null 2>&1
  sleep 5
  code=$(http_code "http://127.0.0.1:$PORT/")
  [ "$code" = 200 ] && REPAIRED=1
fi
if [ "$code" = 200 ]; then ok "GET / 200 (127.0.0.1:$PORT)"
else bad "GET / $code — see: journalctl --user -u lfg.service -n 50"; FAILED=1; fi

api=$(http_code "http://127.0.0.1:$PORT/api/sessions")
if [ "$api" = 200 ]; then ok "GET /api/sessions 200"
else bad "GET /api/sessions $api"; FAILED=1; fi

if [ -n "$PUBLIC_URL" ]; then
  pub=$(http_code "$PUBLIC_URL")
  if [ "$pub" = 200 ]; then ok "public URL 200"
  else bad "public URL $pub — check tailscaled / lfg-connect"; FAILED=1; fi
else
  skip "no LFG_PUBLIC_URL set — external check skipped"
fi

# 4. sessions ---------------------------------------------------------------
# Agent sessions live in tmux, which does not survive a reboot. lfg gates its
# session list on `tmux has-session`, so stale "running" rows in
# data/managed-sessions.json are filtered out already and need no cleanup —
# resume the ones you still want from the web UI.
if as_svc tmux ls >/dev/null 2>&1; then
  echo "sessions: tmux server up — $(as_svc tmux ls 2>/dev/null | wc -l) session(s)"
else
  echo "sessions: no tmux server (agent sessions do not survive a reboot; resume from the UI)"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "lfg-doctor: UNHEALTHY"
  exit 1
elif [ "$REPAIRED" -ne 0 ]; then
  echo "lfg-doctor: repaired — lfg is back up"
else
  echo "lfg-doctor: healthy"
fi
