#!/usr/bin/env bash
#
# omg - one-command setup for a fresh VPS or macOS workstation.
#
# Provisions Bun, tmux, git, fetches omg, optionally joins your Tailscale
# tailnet, and runs the web UI as a background user service. Agent CLIs are
# detected but not installed unless explicitly requested.
#
# Brand-new VPS (run as a normal sudo user, NOT root):
#   curl -fsSL https://raw.githubusercontent.com/BennyKok/omg.dev/main/scripts/setup.sh | bash
#   # or non-interactively, with the Tailscale auth key supplied up front:
#   curl -fsSL https://raw.githubusercontent.com/BennyKok/omg.dev/main/scripts/setup.sh | TS_AUTHKEY=tskey-auth-xxxx bash
#
# Re-run / update after install:
#   omg setup
#
# It is idempotent - safe to run repeatedly.

set -euo pipefail

# ---- OMG_* / LFG_* aliasing ---------------------------------------------
# The bash half of src/env-compat.ts. This script reads LFG_* names internally;
# mirroring first means `OMG_PORT=9000 curl ... | bash` works, and OMG_ wins
# when a name is somehow set both ways. Must run before any default below is
# resolved, or the mirrored value would arrive after the ${VAR:-default} that
# was supposed to see it.
for _omg_var in $(compgen -v OMG_ 2>/dev/null || true); do
  _legacy_var="LFG_${_omg_var#OMG_}"
  printf -v "$_legacy_var" '%s' "${!_omg_var}"
  export "${_legacy_var?}"
done
unset _omg_var _legacy_var

# ---- config (override via env) ----
LFG_REPO_URL="${LFG_REPO_URL:-https://github.com/BennyKok/omg.dev.git}"
# Where prebuilt release tarballs live (GitHub "owner/repo"). Defaults align
# with LFG_REPO_URL but can be pointed at a fork.
LFG_REPO_SLUG="${LFG_REPO_SLUG:-BennyKok/omg.dev}"
# Install location. A fresh box gets ~/omg; a box that already has ~/lfg keeps
# it, because moving a live install's directory would strip it of its data/ and
# .env and orphan the unit's WorkingDirectory.
if [ -n "${LFG_DIR:-}" ]; then
  LFG_DIR="$LFG_DIR"
elif [ -d "$HOME/lfg" ] && [ ! -d "$HOME/omg" ]; then
  LFG_DIR="$HOME/lfg"
else
  LFG_DIR="$HOME/omg"
fi
LFG_REPOS_ROOT="${LFG_REPOS_ROOT:-$HOME/repos}"
LFG_PORT="${LFG_PORT:-8766}"
# Named local URL, opt-in. Maps a hostname to 127.0.0.1 in /etc/hosts so the UI
# has a memorable address, without binding the server to any non-loopback
# interface - an mDNS <host>.local name resolves to the LAN address instead,
# where nothing is listening.
#
# Off by default because /etc/hosts is root-owned, and a sudo password prompt
# has no business interrupting a first install for a cosmetic URL. Turn it on
# when you want it:  OMG_LOCAL_HOSTNAME=omg.local omg setup
LFG_LOCAL_HOSTNAME="${LFG_LOCAL_HOSTNAME-}"
LFG_HOSTS_FILE="${LFG_HOSTS_FILE:-/etc/hosts}"
TS_AUTHKEY="${TS_AUTHKEY:-}"
# Service identity. Same rule as the install directory: new boxes get `omg`,
# and a box already running `lfg.service` keeps it rather than being migrated
# out from under a running control plane. Renaming a unit means stopping the
# thing that is currently working and hoping its replacement comes up.
if [ -f "$HOME/.config/systemd/user/lfg.service" ] && [ ! -f "$HOME/.config/systemd/user/omg.service" ]; then
  SERVICE="lfg"
else
  SERVICE="omg"
fi
# Not dev.omg.omg: the mechanical reverse-DNS answer duplicates the word and
# reads like a packaging bug in `launchctl list`.
if [ -f "$HOME/Library/LaunchAgents/dev.omg.lfg.plist" ] && [ ! -f "$HOME/Library/LaunchAgents/dev.omg.serve.plist" ]; then
  SERVICE_LABEL="dev.omg.lfg"
else
  SERVICE_LABEL="dev.omg.serve"
fi
# Install source:
#   release (default) - download the bundled tarball, then run a production
#                       install. Private/unpublished deps may be bundled under
#                       vendor/*.tgz and referenced from package.json.
#   source            - git clone + `bun install` (for development / forks that
#                       can resolve the private provider themselves).
LFG_INSTALL_MODE="${LFG_INSTALL_MODE:-release}"
# Which release to pull in release mode: "latest" or a tag like v0.1.0.
LFG_RELEASE="${LFG_RELEASE:-latest}"
# Non-destructive defaults:
#   - macOS never installs/updates user tools unless opted in.
#   - agent CLIs are never installed unless opted in; existing installs are used.
if [ "$(uname -s)" = "Darwin" ]; then
  LFG_INSTALL_SYSTEM_DEPS="${LFG_INSTALL_SYSTEM_DEPS:-0}"
  LFG_INSTALL_BUN="${LFG_INSTALL_BUN:-0}"
  LFG_UPDATE_SHELL_RC="${LFG_UPDATE_SHELL_RC:-0}"
else
  LFG_INSTALL_SYSTEM_DEPS="${LFG_INSTALL_SYSTEM_DEPS:-1}"
  LFG_INSTALL_BUN="${LFG_INSTALL_BUN:-1}"
  LFG_UPDATE_SHELL_RC="${LFG_UPDATE_SHELL_RC:-1}"
fi
LFG_INSTALL_CLAUDE="${LFG_INSTALL_CLAUDE:-0}"
LFG_INSTALL_CODEX="${LFG_INSTALL_CODEX:-0}"
LFG_INSTALL_OPENCODE="${LFG_INSTALL_OPENCODE:-0}"
LFG_INSTALL_GROK="${LFG_INSTALL_GROK:-0}"
LFG_INSTALL_CURSOR="${LFG_INSTALL_CURSOR:-0}"
LFG_INSTALL_COPILOT="${LFG_INSTALL_COPILOT:-0}"
# pi is not bundled any more: its provider layer pulls eleven SDKs (Anthropic,
# OpenAI, Google GenAI, Mistral, Bedrock) totalling ~115MB, for one optional
# agent. Opting in is recorded in .env so a later update reinstalls it instead
# of silently dropping it when the release tree is replaced.
LFG_INSTALL_PI="${LFG_INSTALL_PI:-0}"
# Pin the installed @github/copilot version so setup is reproducible. Override
# with LFG_COPILOT_VERSION=x.y.z (or "latest" for opt-in floating installs).
# 1.0.71 audits clean; <=1.0.42 is affected by GHSA-9ccr-r5hg-74gf
# (core.fsmonitor RCE via nested bare repo) and <=0.0.422 is affected by
# GHSA-g8r9-g2v8-jv6f (shell parameter-expansion bypass of the read-only
# safety classification, exploitable through prompt injection).
LFG_COPILOT_VERSION="${LFG_COPILOT_VERSION:-1.0.71}"
LFG_INSTALL_MCP="${LFG_INSTALL_MCP:-1}"
# Installing the Tailscale daemon is a separate decision from exposing the UI
# over it. Both are off unless asked for.
LFG_INSTALL_TAILSCALE="${LFG_INSTALL_TAILSCALE:-0}"
LFG_TAILSCALE_SERVE="${LFG_TAILSCALE_SERVE:-0}"
LFG_TAILSCALE_SERVE_OVERWRITE="${LFG_TAILSCALE_SERVE_OVERWRITE:-0}"
# Asking to be served over the tailnet is asking for the tailnet. Without this,
# OMG_TAILSCALE_SERVE=1 on a box with no Tailscale would quietly do nothing.
[ "$LFG_TAILSCALE_SERVE" = "1" ] && LFG_INSTALL_TAILSCALE=1
LFG_TAILSCALE_HTTPS_PORT="${LFG_TAILSCALE_HTTPS_PORT:-443}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

on_err() { die "setup failed at line $1. Fix the issue above and re-run - it resumes safely."; }
trap 'on_err $LINENO' ERR

# ---- preflight ----
[ "$(id -u)" -eq 0 ] && die "Run as a normal sudo-capable user, not root - agents must not run as root."
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux)
    command -v sudo >/dev/null   || die "sudo is required."
    command -v apt-get >/dev/null || die "This script targets Debian/Ubuntu on Linux (apt-get not found)."
    command -v systemctl >/dev/null || die "systemd (systemctl) is required on Linux."
    ;;
  Darwin)
    ;;
  *)
    die "Unsupported OS: $OS_NAME. This script supports Debian/Ubuntu Linux and macOS."
    ;;
esac

# If invoked from inside an existing checkout (i.e. via `omg setup`), use it.
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
if [ -n "$SCRIPT_SRC" ] && [ -f "$SCRIPT_SRC" ]; then
  MAYBE_ROOT="$(cd "$(dirname "$SCRIPT_SRC")/.." && pwd)"
  if [ -f "$MAYBE_ROOT/package.json" ] && grep -qE '"name": *"(omg|lfg)"' "$MAYBE_ROOT/package.json" 2>/dev/null; then
    LFG_DIR="$MAYBE_ROOT"
  fi
fi

# Tag every line we append to a user's shell rc, so uninstall can take exactly
# its own lines back out instead of leaving PATH edits behind forever. Keep in
# sync with src/commands/uninstall.ts.
RC_MARKER="# added by omg.dev setup"

ensure_path_line() { # append a line to common interactive shell rc files once
  [ "$LFG_UPDATE_SHELL_RC" = "1" ] || return 0
  local line="$1"
  local files=("$HOME/.bashrc")
  if [ "$OS_NAME" = "Darwin" ]; then
    files+=("$HOME/.zshrc")
  fi
  for file in "${files[@]}"; do
    # Substring match, not whole-line: installs from before the marker existed
    # carry the bare line, and appending a marked twin would duplicate the PATH
    # entry on every subsequent setup.
    grep -qF "$line" "$file" 2>/dev/null && continue
    printf '%s %s\n' "$line" "$RC_MARKER" >> "$file"
  done
}

# Link a command name at our CLI without trampling someone else's.
#
# `ln -sf` overwrites whatever is in the way, which made setup the destructive
# half of a pair whose uninstall carefully refuses to remove a link it does not
# own. That asymmetry bites hardest on `omg`: the omg.dev CLI installs a command
# by the same name, so an unconditional force-link silently replaces it.
link_command() {
  local name="$1" target="$2" path="$HOME/.local/bin/$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    local current=""
    [ -L "$path" ] && current="$(readlink "$path" 2>/dev/null || true)"
    if [ "$current" != "$target" ]; then
      # Ours from a previous install (any install dir) is fair game to update;
      # anything else belongs to the user or another tool.
      case "$current" in
        */src/cli.ts) ;;
        *)
          warn "Leaving existing ${path} alone (not installed by omg.dev). Run it as ${target} or remove that file and re-run setup."
          return 0
          ;;
      esac
    fi
  fi
  ln -sf "$target" "$path"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify the checksum."
  fi
}

mktemp_tgz() {
  mktemp "${TMPDIR:-/tmp}/lfg.XXXXXX"
}

platform_asset() {
  local os arch
  case "$OS_NAME" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) die "Unsupported OS: $OS_NAME" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac
  printf 'omg-%s-%s.tar.gz' "$os" "$arch"
}

tailscale_sudo() {
  if [ "$OS_NAME" = "Linux" ]; then
    sudo tailscale "$@"
  else
    tailscale "$@"
  fi
}

tailscale_serve_endpoint_target() {
  local port_key="tcp:$1"
  local cfg
  cfg="$(tailscale_sudo serve get-config --all 2>/dev/null || true)"
  [ -n "$cfg" ] || return 0
  printf '%s' "$cfg" | jq -r --arg port "$port_key" '
    first(
      (.services // {})
      | to_entries[]
      | (.value.endpoints // {})
      | to_entries[]
      | select(.key == $port)
      | .value
    ) // empty
  ' 2>/dev/null
}

# ---- named local URL ----
# Two ways to give the UI a memorable address, preferred in this order:
#
#   1. A public DNS name whose A record points at 127.0.0.1. Costs the user
#      nothing: no sudo, no hosts file, no cleanup on uninstall, and it works
#      identically on macOS and Linux. This is how Drizzle Studio and friends do
#      it. Requires one A record on a domain we control, so it is checked rather
#      than assumed - and only trusted when it really resolves to loopback,
#      since a name that resolves anywhere else would point the UI at a machine
#      that is not this one.
#   2. An /etc/hosts entry, which works offline and for any name, but is
#      root-owned and therefore needs sudo. Opt-in via OMG_LOCAL_HOSTNAME.
LFG_DNS_HOSTNAME="${LFG_DNS_HOSTNAME-local.omg.dev}"

# Keep these markers in sync with src/commands/uninstall.ts, which removes the
# same block. They delimit the only lines setup owns in the hosts file.
HOSTS_BEGIN="# >>> omg local hostname >>>"
HOSTS_END="# <<< omg local hostname <<<"

resolves_to_loopback() { # every A record for $1 is 127.x, and there is at least one
  local name="$1" addrs=""
  if command -v dig >/dev/null 2>&1; then
    addrs="$(dig +short +time=2 +tries=1 A "$name" 2>/dev/null | grep -E '^[0-9.]+$' || true)"
  elif command -v getent >/dev/null 2>&1; then
    addrs="$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  elif command -v dscacheutil >/dev/null 2>&1; then
    addrs="$(dscacheutil -q host -a name "$name" 2>/dev/null | awk '/^ip_address:/ {print $2}' || true)"
  else
    return 1
  fi
  [ -n "$addrs" ] || return 1
  local addr
  while IFS= read -r addr; do
    [ -n "$addr" ] || continue
    case "$addr" in
      127.*) ;;
      *) return 1 ;;
    esac
  done <<EOF
$addrs
EOF
  return 0
}

hosts_entry_present() { # already mapped to loopback, by us or by hand?
  local name="$1"
  awk -v want="$name" '
    { sub(/#.*/, "") }
    $1 == "127.0.0.1" { for (i = 2; i <= NF; i++) if ($i == want) { found = 1 } }
    END { exit found ? 0 : 1 }
  ' "$LFG_HOSTS_FILE" 2>/dev/null
}

LOCAL_HOSTNAME_READY=0
ensure_local_hostname() {
  # A DNS name that already points at loopback needs nothing installed, so it
  # wins over the hosts file whenever it is available - no sudo, nothing for
  # uninstall to clean up. An explicit OMG_LOCAL_HOSTNAME still overrides it,
  # because someone naming a host by hand means it.
  if [ -z "$LFG_LOCAL_HOSTNAME" ] && [ -n "$LFG_DNS_HOSTNAME" ]; then
    if resolves_to_loopback "$LFG_DNS_HOSTNAME"; then
      LFG_LOCAL_HOSTNAME="$LFG_DNS_HOSTNAME"
      LOCAL_HOSTNAME_READY=1
      say "Named local URL: ${LFG_DNS_HOSTNAME} (public DNS, already points at 127.0.0.1)."
      return 0
    fi
  fi
  [ -n "$LFG_LOCAL_HOSTNAME" ] || return 0
  # An explicit name that is already a loopback DNS record needs no hosts entry
  # either.
  if resolves_to_loopback "$LFG_LOCAL_HOSTNAME"; then
    LOCAL_HOSTNAME_READY=1
    say "Named local URL: ${LFG_LOCAL_HOSTNAME} (already resolves to 127.0.0.1)."
    return 0
  fi
  # A pre-existing mapping counts as ready. Rewriting a line we did not add
  # would take ownership of it, and uninstall would then delete someone else's
  # entry.
  if hosts_entry_present "$LFG_LOCAL_HOSTNAME"; then
    LOCAL_HOSTNAME_READY=1
    say "Named local URL already configured (${LFG_LOCAL_HOSTNAME})."
    return 0
  fi
  # curl|bash leaves stdin on the pipe, so -t 0 is false even on a real
  # terminal; sudo can still prompt through /dev/tty. Only give up when there is
  # no cached credential AND nowhere to ask.
  if ! sudo -n true 2>/dev/null && [ ! -t 0 ] && [ ! -c /dev/tty ]; then
    warn "No sudo available for ${LFG_HOSTS_FILE}; skipping ${LFG_LOCAL_HOSTNAME}. http://localhost:$LFG_PORT still works."
    return 0
  fi
  say "Mapping ${LFG_LOCAL_HOSTNAME} to 127.0.0.1 in ${LFG_HOSTS_FILE} (needs sudo)..."
  # 127.0.0.1 only. The service binds IPv4 loopback, so publishing a ::1 twin
  # would hand browsers an address that refuses the connection - and browsers
  # prefer IPv6 when both resolve.
  if printf '%s\n127.0.0.1\t%s\n%s\n' "$HOSTS_BEGIN" "$LFG_LOCAL_HOSTNAME" "$HOSTS_END" \
    | sudo tee -a "$LFG_HOSTS_FILE" >/dev/null; then
    LOCAL_HOSTNAME_READY=1
  else
    warn "Could not write ${LFG_HOSTS_FILE}; skipping ${LFG_LOCAL_HOSTNAME}. http://localhost:$LFG_PORT still works."
  fi
}

# ---- 1. base packages ----
if [ "$OS_NAME" = "Linux" ]; then
  [ "$LFG_INSTALL_SYSTEM_DEPS" = "1" ] || die "Missing or unchecked system deps. Re-run with LFG_INSTALL_SYSTEM_DEPS=1, or install git, tmux, curl, ca-certificates, and jq yourself."
  say "Installing base packages (git, tmux, curl, jq)..."
  sudo apt-get update -y -qq
  sudo apt-get install -y -qq git tmux curl ca-certificates jq
else
  MISSING_PKGS=()
  for pkg in git tmux curl jq; do
    command -v "$pkg" >/dev/null 2>&1 || MISSING_PKGS+=("$pkg")
  done
  if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
    if [ "$LFG_INSTALL_SYSTEM_DEPS" = "1" ]; then
      command -v brew >/dev/null 2>&1 || die "Homebrew is required to install missing packages on macOS: ${MISSING_PKGS[*]}"
      say "Installing base packages with Homebrew (${MISSING_PKGS[*]})..."
      brew install "${MISSING_PKGS[@]}"
    else
      die "Missing required commands on macOS: ${MISSING_PKGS[*]}. Install them yourself, or re-run with LFG_INSTALL_SYSTEM_DEPS=1 to let setup use Homebrew."
    fi
  else
    say "Base packages already installed."
  fi
fi

# ---- 2. Bun ----
if ! command -v bun >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_BUN" = "1" ]; then
    say "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
  else
    die "Bun is required but was not found on PATH. Install Bun yourself, or re-run with LFG_INSTALL_BUN=1 to let setup run the Bun installer."
  fi
fi
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
ensure_path_line 'export PATH="$HOME/.bun/bin:$PATH"'
BUN_BIN="$(command -v bun || true)"
[ -n "$BUN_BIN" ] || die "Bun is required but was not found on PATH."
BUN_BIN="$(cd "$(dirname "$BUN_BIN")" && pwd)/$(basename "$BUN_BIN")"

# ---- 3. agent CLIs ----
# omg.dev drives whatever claude / codex / opencode / grok / cursor-agent /
# copilot it finds on PATH (override via OMG_<AGENT>_PATH). None are installed
# or upgraded by default: they own the user's auth and config.
#
# A missing agent is not worth a warning. Six near-identical paragraphs of "X
# not found, re-run with LFG_INSTALL_X=1" buried the actual outcome of the
# install in noise, for a situation that is both normal and fixable later from
# Settings -> Coding agents. They are counted and reported in one line instead.
AGENTS_READY=()
AGENTS_MISSING=()

is_grok_agent() {
  local bin="$1"
  local real
  real="$(readlink -f "$bin" 2>/dev/null || printf '%s' "$bin")"
  case "$real" in
    "$HOME"/.grok/*|*/grok-linux-x86_64) return 0 ;;
    *) return 1 ;;
  esac
}

has_cursor_cli() {
  if command -v cursor-agent >/dev/null 2>&1; then
    return 0
  fi
  local agent_bin
  agent_bin="$(command -v agent 2>/dev/null || true)"
  [ -n "$agent_bin" ] && ! is_grok_agent "$agent_bin"
}

pi_pinned_version() {
  jq -r '(.devDependencies["@earendil-works/pi-coding-agent"] // .dependencies["@earendil-works/pi-coding-agent"] // "latest")' \
    "$LFG_DIR/package.json" 2>/dev/null | sed 's/^[\^~]//'
}

run_agent_installer() {
  case "$1" in
    claude)   curl -fsSL https://claude.ai/install.sh | bash ;;
    codex)    "$BUN_BIN" add -g @openai/codex >/dev/null 2>&1 ;;
    opencode) "$BUN_BIN" add -g opencode-ai >/dev/null 2>&1 ;;
    grok)     curl -fsSL https://x.ai/cli/install.sh | bash ;;
    cursor)   curl -fsSL https://cursor.com/install | bash ;;
    pi)
      # Installed into the install directory, which is where the harness and
      # detection both look for it.
      ( cd "$LFG_DIR" && "$BUN_BIN" add "@earendil-works/pi-coding-agent@$(pi_pinned_version)" >/dev/null 2>&1 )
      ;;
    copilot)
      if [ "$LFG_COPILOT_VERSION" = "latest" ]; then
        npm install -g "@github/copilot" >/dev/null 2>&1
      else
        npm install -g "@github/copilot@${LFG_COPILOT_VERSION}" >/dev/null 2>&1
      fi
      ;;
    *) return 1 ;;
  esac
}

# ensure_agent <label> <want-install> <probe command...>
#
# The probe runs inside `if`, which is a condition context. Writing it as
# `probe; ensure_agent ... "$?"` looks equivalent and is not: under
# `set -euo pipefail` a probe that returns non-zero aborts the whole script, so
# setup died on the first agent that was not installed - which is most machines.
ensure_agent() {
  local label="$1" want="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then
    AGENTS_READY+=("$label")
    return 0
  fi
  if [ "$want" != "1" ]; then
    AGENTS_MISSING+=("$label")
    return 0
  fi
  say "Installing ${label}..."
  if run_agent_installer "$label"; then
    AGENTS_READY+=("$label")
  else
    warn "${label} install failed; it stays unavailable."
    AGENTS_MISSING+=("$label")
  fi
}

ensure_agent claude "$LFG_INSTALL_CLAUDE" command -v claude
# Claude's installer drops the binary here, so PATH has to know about it before
# anything downstream (MCP registration) looks for it.
export PATH="$HOME/.local/bin:$PATH"
ensure_path_line 'export PATH="$HOME/.local/bin:$PATH"'

ensure_agent codex    "$LFG_INSTALL_CODEX"    command -v codex
ensure_agent opencode "$LFG_INSTALL_OPENCODE" command -v opencode
ensure_agent grok     "$LFG_INSTALL_GROK"     command -v grok
ensure_agent cursor   "$LFG_INSTALL_CURSOR"   has_cursor_cli
ensure_agent copilot  "$LFG_INSTALL_COPILOT"  command -v copilot
ensure_agent pi       "$LFG_INSTALL_PI"       test -f "$LFG_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"

# ---- 4. fetch lfg (bundled release tarball, or git clone for dev) ----
# A git checkout always wins - `lfg setup` from inside a dev clone updates via
# git, never clobbering it with a release tarball.
if [ -d "$LFG_DIR/.git" ]; then
  LFG_INSTALL_MODE="source"
fi

if [ "$LFG_INSTALL_MODE" = "source" ]; then
  if [ -d "$LFG_DIR/.git" ]; then
    say "Updating omg.dev at ${LFG_DIR} (git)..."
    git -C "$LFG_DIR" pull --ff-only || warn "git pull skipped (local changes?)"
  else
    say "Cloning omg.dev into ${LFG_DIR} (git)..."
    git clone "$LFG_REPO_URL" "$LFG_DIR"
  fi
  # The web UI ships prebuilt in web/dist, so no web build is needed here.
  say "Installing dependencies..."
  ( cd "$LFG_DIR" && "$BUN_BIN" install )
else
  # Release mode: download source + prebuilt web UI + optional vendor tarballs,
  # extract them over $LFG_DIR, then install public deps on this target platform.
  # Strip the leading lfg/ dir; leaves $LFG_DIR/.env and data/ (not in the tarball) intact.
  # Explicitly replace application files and skip archive metadata. Some hosted
  # sandboxes inject TAR_OPTIONS=--keep-old-files and/or reject chmod/chown/utime
  # even though the workspace itself is writable.
  #
  # The replace/metadata flags differ per tar flavour. `--overwrite` and `--touch`
  # are GNU-only, and macOS's bsdtar treats an unknown long option as a hard usage
  # error ("Option --overwrite is not supported"), which aborted setup on every Mac.
  # bsdtar needs neither: it overwrites by default, ignores TAR_OPTIONS (a GNU env
  # var), and spells --touch as -m. Keep this in sync with extractReleaseArchive()
  # in src/self-update.ts, which solves the same problem for in-place updates.
  extract_release_archive() {
    local archive="$1" dest="$2"
    local flavour_flags="-m"
    if tar --version 2>/dev/null | grep -q 'GNU tar'; then
      flavour_flags="--overwrite --touch"
    fi
    # shellcheck disable=SC2086
    TAR_OPTIONS= tar -xzf "$archive" -C "$dest" --strip-components=1 \
      $flavour_flags --no-same-owner --no-same-permissions
  }

  release_url() {
    local asset="$1"
    if [ "$LFG_RELEASE" = "latest" ]; then
      printf 'https://github.com/%s/releases/latest/download/%s' "$LFG_REPO_SLUG" "$asset"
    else
      printf 'https://github.com/%s/releases/download/%s/%s' "$LFG_REPO_SLUG" "$LFG_RELEASE" "$asset"
    fi
  }

  # Asset preference, best first:
  #   1. omg-<os>-<arch>  - ships node_modules already installed and pruned for
  #      this platform, so no dependency resolution happens here at all. That is
  #      the difference between a ~2GB download and a small one, because the
  #      neutral bundle's target-side install also pulls musl builds this host
  #      cannot execute (Bun filters optionalDependencies by os and cpu, not libc).
  #   2. omg-bundle       - platform-neutral, needs a target-side bun install.
  #   3. lfg-bundle       - pre-rename name; pinning LFG_RELEASE to an older tag
  #                         has to keep working.
  # An explicit LFG_RELEASE_ASSET overrides the lot and is never second-guessed.
  if [ -n "${LFG_RELEASE_ASSET:-}" ]; then
    ASSET_CANDIDATES=("$LFG_RELEASE_ASSET")
  else
    ASSET_CANDIDATES=("$(platform_asset)" "omg-bundle.tar.gz" "lfg-bundle.tar.gz")
  fi

  say "Downloading bundled release (${LFG_RELEASE}) from ${LFG_REPO_SLUG}..."
  TMP_TGZ=""
  ASSET=""
  for candidate in "${ASSET_CANDIDATES[@]}"; do
    URL="$(release_url "$candidate")"
    attempt="$(mktemp_tgz)"
    if curl -fL --progress-bar "$URL" -o "$attempt" && [ -s "$attempt" ]; then
      ASSET="$candidate"
      TMP_TGZ="$attempt"
      say "Using $ASSET."
      break
    fi
    rm -f "$attempt"
  done
  if [ -z "$ASSET" ]; then
    if [ -n "${LFG_RELEASE_ASSET:-}" ]; then
      die "Could not download ${LFG_RELEASE_ASSET} - check the tag, or use LFG_INSTALL_MODE=source."
    fi
    die "Could not download any release asset (${ASSET_CANDIDATES[*]}) - check the tag, set LFG_RELEASE_ASSET explicitly, or use LFG_INSTALL_MODE=source."
  fi
  URL="$(release_url "$ASSET")"
  # Verify the checksum when the release ships one (best-effort).
  if curl -fsSL "$URL.sha256" -o "$TMP_TGZ.sha256" 2>/dev/null; then
    EXPECTED="$(awk '{print $1}' "$TMP_TGZ.sha256")"
    ACTUAL="$(sha256_file "$TMP_TGZ")"
    [ "$EXPECTED" = "$ACTUAL" ] || die "Checksum mismatch for $ASSET - refusing to install."
    say "Checksum verified."
  fi
  mkdir -p "$LFG_DIR"
  # Clear the previous dependency tree BEFORE extracting, so that afterwards
  # node_modules exists only if this bundle shipped one. Two reasons:
  #   - a platform bundle laid over an older node_modules merges two trees and
  #     keeps every file the new release dropped;
  #   - "node_modules exists" would otherwise be true on any re-run, so a
  #     neutral bundle installed over an existing tree would skip the install it
  #     actually needs and run new code against old dependencies.
  # The install branch below removed the directory anyway, so nothing extra is
  # thrown away. LFG_SKIP_BUN_INSTALL means "do not touch dependencies", so that
  # escape hatch keeps whatever is already there.
  if [ "${LFG_SKIP_BUN_INSTALL:-0}" != "1" ]; then
    rm -rf "$LFG_DIR/node_modules"
  fi
  say "Extracting into ${LFG_DIR}..."
  extract_release_archive "$TMP_TGZ" "$LFG_DIR"
  rm -f "$TMP_TGZ" "$TMP_TGZ.sha256"

  # A platform bundle already carries node_modules, correct for this OS/arch and
  # pruned of builds that cannot run here. Re-resolving on top of it would undo
  # the entire point of shipping it, so only install when dependencies are
  # genuinely absent.
  if [ "${LFG_SKIP_BUN_INSTALL:-0}" = "1" ]; then
    warn "Skipping production dependency install because LFG_SKIP_BUN_INSTALL=1."
  elif [ -d "$LFG_DIR/node_modules" ] && [ -n "$(ls -A "$LFG_DIR/node_modules" 2>/dev/null)" ]; then
    say "Dependencies shipped with $ASSET - skipping install."
  else
    say "Installing production dependencies on this machine..."
    ( cd "$LFG_DIR" && unset CI && "$BUN_BIN" install --production )
  fi
fi

# ---- 6. expose the command on PATH ----
# `lfg` is the unambiguous name for this CLI and is always installed: existing
# scripts, cron entries and muscle memory keep working, and the npm CLI
# (@omg-dev/cli) resolves `lfg` when it forwards a command here.
mkdir -p "$HOME/.local/bin"
link_command lfg "$LFG_DIR/src/cli.ts"

# `omg` is contested in a way link_command cannot see: it guards the path
# ~/.local/bin/omg, but the npm CLI (@omg-dev/cli) installs its `omg` in the npm
# global bin. Linking ours anyway leaves two programs under one name, with PATH
# order deciding which the name means — and since we prepend ~/.local/bin, ours
# wins and silently shadows theirs.
#
# Find an `omg` that is not ours. Two things this must not assume:
#
#   - that `command -v omg` finds it. With ~/.local/bin first on PATH it
#     returns our own symlink on any box we have already touched, so we would
#     keep the name forever.
#   - that ~/.local/bin/omg is ours. npm's global prefix is often ~/.local, so
#     `npm i -g @omg-dev/cli` puts *its* omg in that very directory. Skipping
#     the path would hide the one CLI we are looking for.
#
# Identify ours the way link_command does: by what the link points at.
other_omg=""
_saved_ifs="$IFS"
IFS=:
for _dir in $PATH; do
  [ -n "$_dir" ] || continue
  [ -x "$_dir/omg" ] || continue
  case "$(readlink "$_dir/omg" 2>/dev/null || true)" in
    */src/cli.ts) continue ;;
  esac
  other_omg="$_dir/omg"
  break
done
IFS="$_saved_ifs"

# Hand the name over only to a CLI that can actually reach this install — a
# newer @omg-dev/cli forwards what it does not own to `lfg`, so `omg serve`
# still works. An older one only prints its own help, so surrendering to it
# would strip commands off this box. Ask rather than assume: its answer to an
# unknown command says which of the two it is. That keeps this independent of
# the npm CLI's release, and self-healing if that CLI is later downgraded.
if [ -n "$other_omg" ] \
  && "$other_omg" __omg_forward_probe </dev/null 2>&1 \
    | grep -q "run and manage your AI coding agents"; then
  say "omg is provided by $other_omg and forwards here - this CLI is 'lfg'."
  # Only ever remove our own link, matching link_command's ownership rule.
  _ours="$(readlink "$HOME/.local/bin/omg" 2>/dev/null || true)"
  case "$_ours" in */src/cli.ts) rm -f "$HOME/.local/bin/omg" ;; esac
else
  [ -n "$other_omg" ] && say "omg at $other_omg cannot forward here yet - keeping ours."
  link_command omg "$LFG_DIR/src/cli.ts"
fi
chmod +x "$LFG_DIR/src/cli.ts" 2>/dev/null || true

install_lfg_mcp() {
  [ "$LFG_INSTALL_MCP" = "1" ] || return 0
  local mcp_args=("$BUN_BIN" "$LFG_DIR/src/cli.ts" "mcp")
  local installed=0
  if command -v claude >/dev/null 2>&1; then
    say "Registering omg.dev MCP with Claude..."
    claude mcp remove lfg -s user >/dev/null 2>&1 || true
    if claude mcp add -s user lfg -- "${mcp_args[@]}" >/dev/null 2>&1; then
      installed=1
    else
      warn "Could not register omg.dev MCP with Claude. Open Settings -> Coding agents in omg.dev and run Install MCP after Claude is authenticated."
    fi
  fi
  if command -v codex >/dev/null 2>&1; then
    say "Registering omg.dev MCP with Codex..."
    codex mcp remove lfg >/dev/null 2>&1 || true
    if codex mcp add lfg -- "${mcp_args[@]}" >/dev/null 2>&1; then
      installed=1
    else
      warn "Could not register omg.dev MCP with Codex. Open Settings -> Coding agents in omg.dev and run Install MCP after Codex is authenticated."
    fi
  fi
  if [ "$installed" != "1" ]; then
    warn "No Claude/Codex MCP registration completed. Install or authenticate a supported CLI, then use Settings -> Coding agents -> Install MCP."
  fi
}

install_lfg_mcp

# ---- 7. .env (never overwrite an existing one) ----
if [ ! -f "$LFG_DIR/.env" ]; then
  say "Creating .env from .env.example..."
  cp "$LFG_DIR/.env.example" "$LFG_DIR/.env"
fi
# New installs are seeded with the OMG_ prefix. Existing installs keep whatever
# LFG_ names they already have - appending an OMG_ twin would silently out-rank
# a customised legacy value, since OMG_ wins in src/env-compat.ts.
#
# An EMPTY assignment does not count as set. .env is copied from .env.example,
# which carries `OMG_REPOS_ROOT=` as a documentation placeholder, and a presence
# check matched that line and skipped the seed - so every fresh install ended up
# with no repos root at all. That is not cosmetic: the folder picker asks the
# server for its default directory, gets 400 "folder does not exist", and the
# drawer strands on "Opening..." with nothing to navigate from.
#
# A placeholder is filled in place rather than appended to, so .env keeps one
# assignment per key instead of two that disagree.
seed_env() {
  local key="$1" value="$2" file="$LFG_DIR/.env"
  # A real value - anything that is not whitespace - is the user's, and stays.
  grep -qE "^(OMG_|LFG_)${key}=[[:space:]]*[^[:space:]]" "$file" && return 0
  if grep -qE "^(OMG_|LFG_)${key}=[[:space:]]*$" "$file"; then
    local staged
    staged="$(mktemp "${TMPDIR:-/tmp}/lfg-env.XXXXXX")"
    awk -v key="$key" -v value="$value" '
      !filled && $0 ~ ("^(OMG_|LFG_)" key "=[[:space:]]*$") {
        print "OMG_" key "=" value
        filled = 1
        next
      }
      { print }
    ' "$file" > "$staged" && cat "$staged" > "$file"
    rm -f "$staged"
    return 0
  fi
  printf '%s=%s\n' "OMG_$key" "$value" >> "$file"
}
# Record the pi opt-in. A release update replaces the tree and clears
# node_modules, so without this the agent someone deliberately installed would
# vanish on the next update with no explanation.
[ "$LFG_INSTALL_PI" = "1" ] && seed_env INSTALL_PI 1
seed_env HOST 127.0.0.1
seed_env PORT "$LFG_PORT"
seed_env REPOS_ROOT "$LFG_REPOS_ROOT"
chmod 600 "$LFG_DIR/.env"
mkdir -p "$LFG_REPOS_ROOT"
mkdir -p "$LFG_DIR/data"
jq -n \
  --arg channel "$LFG_INSTALL_MODE" \
  --arg repoSlug "$LFG_REPO_SLUG" \
  --arg release "$LFG_RELEASE" \
  --arg releaseAsset "${ASSET:-${LFG_RELEASE_ASSET:-omg-bundle.tar.gz}}" \
  --arg installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{channel:$channel, repoSlug:$repoSlug, release:$release, releaseAsset:$releaseAsset, installedAt:$installedAt}' \
  > "$LFG_DIR/data/install.json"

# ---- 8. Tailscale (opt-in) ----
# Remote access is a choice, not part of getting omg.dev running. Setup used to
# install the Tailscale daemon on every Linux box whether or not the user wanted
# remote access, then interactively demand an auth key - and with no TTY, which
# is exactly what `curl ... | bash` gives you, it called die(). A fresh box got a
# system daemon it never asked for and a failed install, for an optional feature.
#
# Nothing here installs, joins, or fails any more unless explicitly requested.
# Enable it afterwards, once the thing is actually running:
#   OMG_INSTALL_TAILSCALE=1 TS_AUTHKEY=tskey-auth-... omg setup
if [ "$LFG_INSTALL_TAILSCALE" = "1" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    if [ "$OS_NAME" = "Linux" ]; then
      say "Installing Tailscale..."
      curl -fsSL https://tailscale.com/install.sh | sh || warn "Tailscale install failed; remote access stays unavailable."
    else
      warn "Tailscale CLI not found. Install Tailscale for macOS, then re-run setup."
    fi
  fi
  if command -v tailscale >/dev/null 2>&1 && ! tailscale status >/dev/null 2>&1; then
    if [ -n "$TS_AUTHKEY" ]; then
      say "Joining your tailnet..."
      tailscale_sudo up --authkey "$TS_AUTHKEY" --ssh || warn "Could not join the tailnet."
      unset TS_AUTHKEY
    else
      # Never block an install on a secret the user has not been asked for yet.
      warn "Tailscale is installed but not logged in. Run: sudo tailscale up --ssh"
    fi
  fi
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  say "Tailscale is already connected; leaving it as it is."
fi

install_linux_service() {
  say "Installing the systemd user service (${SERVICE})..."
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SERVICE-agents.slice" <<'UNIT'
[Unit]
Description=omg.dev managed agent memory boundary

[Slice]
# Keep reclaim local to the swarm. memory.high throttles first; memory.max is
# the last-resort cgroup OOM boundary. Idle anonymous pages may use swap.
MemoryHigh=4G
MemoryMax=5G
UNIT
  cat > "$UNIT_DIR/$SERVICE.service" <<UNIT
[Unit]
Description=omg.dev - self-hosted AI coding agent control plane
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$LFG_DIR
EnvironmentFile=$LFG_DIR/.env
# claude/codex must resolve when spawned into tmux panes (see src/tmux.ts).
Environment=PATH=$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
# Hard-bind to loopback so a stale .env can never expose the UI publicly.
# Both spellings are pinned: src/env-compat.ts lets OMG_HOST out-rank LFG_HOST,
# so pinning only the legacy name would let a stale .env defeat this.
Environment=LFG_HOST=127.0.0.1
Environment=OMG_HOST=127.0.0.1
# agent-browser defaults idle off; without this, headless Chrome orphans pile up
# when agents forget `close`. Inherited by every managed agent spawn.
Environment=AGENT_BROWSER_IDLE_TIMEOUT_MS=300000
ExecStart=$BUN_BIN run $LFG_DIR/src/cli.ts serve
Restart=on-failure
RestartSec=3
# Managed agent processes (plus tmux for native TUI agents) originate under
# serve's cgroup. With KillMode=control-group a deploy restart wipes them all;
# kill only the main bun process so direct SDK and tmux sessions both survive.
KillMode=process

[Install]
WantedBy=default.target
UNIT

  # Keep the user manager (and tmux + lfg serve) alive across logout/reboot.
  sudo loginctl enable-linger "$USER"
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE.service"
  systemctl --user restart "$SERVICE.service"
}

xml_escape() {
  sed -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

install_macos_service() {
  say "Installing the launchd user service (${SERVICE_LABEL})..."
  UNIT_DIR="$HOME/Library/LaunchAgents"
  LOG_DIR="$HOME/Library/Logs"
  PLIST="$UNIT_DIR/$SERVICE_LABEL.plist"
  mkdir -p "$UNIT_DIR" "$LOG_DIR"

  START_CMD="cd \"$LFG_DIR\" && set -a && [ -f \"$LFG_DIR/.env\" ] && . \"$LFG_DIR/.env\"; set +a; export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\" LFG_HOST=127.0.0.1 OMG_HOST=127.0.0.1; exec \"$BUN_BIN\" run \"$LFG_DIR/src/cli.ts\" serve"
  XML_START_CMD="$(printf '%s' "$START_CMD" | xml_escape)"
  XML_LFG_DIR="$(printf '%s' "$LFG_DIR" | xml_escape)"
  XML_LOG_DIR="$(printf '%s' "$LOG_DIR" | xml_escape)"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>WorkingDirectory</key>
  <string>$XML_LFG_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>$XML_START_CMD</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$XML_LOG_DIR/lfg.out.log</string>
  <key>StandardErrorPath</key>
  <string>$XML_LOG_DIR/lfg.err.log</string>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl load "$PLIST"
  launchctl enable "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$(id -u)/$SERVICE_LABEL" >/dev/null 2>&1 || true
}

# ---- 9. background user service ----
if [ "$OS_NAME" = "Linux" ]; then
  install_linux_service
else
  install_macos_service
fi

ensure_local_hostname

TAILSCALE_SERVE_CONFIGURED=0

# ---- 10. optionally expose the UI over the tailnet (HTTPS on MagicDNS), never publicly ----
if [ "$LFG_TAILSCALE_SERVE" != "1" ]; then
  :
elif command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  LFG_TAILSCALE_TARGET="http://127.0.0.1:$LFG_PORT"
  EXISTING_TAILSCALE_TARGET="$(tailscale_serve_endpoint_target "$LFG_TAILSCALE_HTTPS_PORT")"
  if [ -n "$EXISTING_TAILSCALE_TARGET" ] \
    && [ "$EXISTING_TAILSCALE_TARGET" != "$LFG_TAILSCALE_TARGET" ] \
    && [ "$LFG_TAILSCALE_SERVE_OVERWRITE" != "1" ]; then
    warn "Tailscale Serve HTTPS port $LFG_TAILSCALE_HTTPS_PORT already points at $EXISTING_TAILSCALE_TARGET; leaving it unchanged."
    warn "Re-run with LFG_TAILSCALE_SERVE_OVERWRITE=1 to replace it, or set LFG_TAILSCALE_HTTPS_PORT to another port."
  else
    say "Configuring tailscale serve https/$LFG_TAILSCALE_HTTPS_PORT -> $LFG_TAILSCALE_TARGET..."
    if tailscale_sudo serve --bg --https="$LFG_TAILSCALE_HTTPS_PORT" "$LFG_TAILSCALE_TARGET"; then
      TAILSCALE_SERVE_CONFIGURED=1
    else
      warn "tailscale serve failed - enable HTTPS/MagicDNS in the Tailscale admin console, then re-run."
    fi
  fi
else
  warn "Tailscale is not connected; omg.dev will be available on this machine at http://127.0.0.1:$LFG_PORT."
fi

# ---- done ----
TAILNET_URL=""
if command -v tailscale >/dev/null 2>&1; then
  TAILNET_URL="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//' || true)"
fi

# The named URL is not setup's doing any more. On macOS `omg serve` advertises
# omg.local over mDNS for as long as it runs, so by the time this prints, the
# service is already answering there - no hosts file and no sudo. Saying
# "optional, needs sudo" here was describing a mechanism we no longer use.
NAMED_URL=""
if [ "$LOCAL_HOSTNAME_READY" = "1" ]; then
  NAMED_URL="http://$LFG_LOCAL_HOSTNAME:$LFG_PORT"
elif [ "$OS_NAME" = "Darwin" ] && command -v dns-sd >/dev/null 2>&1; then
  NAMED_URL="http://omg.local:$LFG_PORT"
fi

echo
if [ "$OS_NAME" = "Linux" ]; then
  say "omg.dev is running as a systemd user service."
else
  say "omg.dev is running as a launchd user service."
fi
echo
[ -n "$NAMED_URL" ] && printf '    Web UI     %s\n               %s\n' "$NAMED_URL" "http://localhost:$LFG_PORT"
[ -n "$NAMED_URL" ] || printf '    Web UI     %s\n' "http://localhost:$LFG_PORT"
[ "$TAILSCALE_SERVE_CONFIGURED" = "1" ] && [ -n "$TAILNET_URL" ] \
  && printf '               %s  (tailnet)\n' "https://$TAILNET_URL"

# One line about agents, instead of a warning per agent that is not installed.
if [ "${#AGENTS_READY[@]}" -gt 0 ]; then
  printf '    Agents     %s\n' "$(IFS=' '; echo "${AGENTS_READY[*]}")"
else
  printf '    Agents     none yet\n'
fi
if [ "${#AGENTS_MISSING[@]}" -gt 0 ]; then
  printf '               add %s in Settings -> Coding agents\n' "$(IFS=' '; echo "${AGENTS_MISSING[*]}")"
fi

if [ "$TAILSCALE_SERVE_CONFIGURED" != "1" ]; then
  printf '    Remote     OMG_TAILSCALE_SERVE=1 omg setup\n'
fi
if [ "$OS_NAME" = "Linux" ]; then
  printf '    Service    systemctl --user restart %s\n' "$SERVICE"
  printf '    Logs       journalctl --user -u %s -f\n' "$SERVICE"
else
  printf '    Service    launchctl kickstart -k gui/%s/%s\n' "$(id -u)" "$SERVICE_LABEL"
  printf '    Logs       tail -f %s\n' "$HOME/Library/Logs/$SERVICE.err.log"
fi
echo
