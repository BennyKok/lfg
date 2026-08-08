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
# Named local URL. Maps a hostname to 127.0.0.1 in /etc/hosts so the UI has a
# memorable address, without binding the server to any non-loopback interface -
# an mDNS <host>.local name resolves to the LAN address instead, where nothing
# is listening. Set to empty to skip the hosts file entirely.
LFG_LOCAL_HOSTNAME="${LFG_LOCAL_HOSTNAME-omg.local}"
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
LFG_INSTALL_HERMES="${LFG_INSTALL_HERMES:-0}"
LFG_INSTALL_COPILOT="${LFG_INSTALL_COPILOT:-0}"
# Pin the installed @github/copilot version so setup is reproducible. Override
# with LFG_COPILOT_VERSION=x.y.z (or "latest" for opt-in floating installs).
# 1.0.71 audits clean; <=1.0.42 is affected by GHSA-9ccr-r5hg-74gf
# (core.fsmonitor RCE via nested bare repo) and <=0.0.422 is affected by
# GHSA-g8r9-g2v8-jv6f (shell parameter-expansion bypass of the read-only
# safety classification, exploitable through prompt injection).
LFG_COPILOT_VERSION="${LFG_COPILOT_VERSION:-1.0.71}"
LFG_INSTALL_MCP="${LFG_INSTALL_MCP:-1}"
LFG_TAILSCALE_SERVE="${LFG_TAILSCALE_SERVE:-0}"
LFG_TAILSCALE_SERVE_OVERWRITE="${LFG_TAILSCALE_SERVE_OVERWRITE:-0}"
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

ensure_path_line() { # append a line to common interactive shell rc files once
  [ "$LFG_UPDATE_SHELL_RC" = "1" ] || return 0
  local line="$1"
  local files=("$HOME/.bashrc")
  if [ "$OS_NAME" = "Darwin" ]; then
    files+=("$HOME/.zshrc")
  fi
  for file in "${files[@]}"; do
    grep -qxF "$line" "$file" 2>/dev/null || echo "$line" >> "$file"
  done
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

# ---- named local URL (/etc/hosts) ----
# Keep these markers in sync with src/commands/uninstall.ts, which removes the
# same block. They delimit the only lines setup owns in the hosts file.
HOSTS_BEGIN="# >>> omg local hostname >>>"
HOSTS_END="# <<< omg local hostname <<<"

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
  [ -n "$LFG_LOCAL_HOSTNAME" ] || return 0
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

# ---- 3. agent CLIs (claude / codex / opencode / grok / cursor / hermes / copilot) ----
# The release bundle ships NO vendored agent binaries - lfg drives whatever
# `claude` / `codex` / `opencode` / `grok` / `agent` / `hermes` / `copilot` it finds on PATH (override via LFG_*_PATH).
# Never install or upgrade these by default: they own user auth/config.
if ! command -v claude >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_CLAUDE" = "1" ]; then
    say "Installing the Claude CLI..."
    curl -fsSL https://claude.ai/install.sh | bash
  else
    warn "Claude CLI not found. OMG will start, but Claude sessions will be unavailable until you install/authenticate claude. Re-run with LFG_INSTALL_CLAUDE=1 only if you want setup to run Anthropic's installer."
  fi
fi
export PATH="$HOME/.local/bin:$PATH"
ensure_path_line 'export PATH="$HOME/.local/bin:$PATH"'

# Optional runtimes. Best-effort: a missing binary just means that agent kind is
# unavailable. Installing is explicit because these CLIs own user auth/config.
if ! command -v codex >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_CODEX" = "1" ]; then
    say "Installing the Codex CLI (optional)..."
    "$BUN_BIN" add -g @openai/codex >/dev/null 2>&1 || warn "codex install failed - the 'codex' agent kind will be unavailable."
  else
    warn "Codex CLI not found. Codex sessions will be unavailable until you install/authenticate codex. Re-run with LFG_INSTALL_CODEX=1 only if you want setup to install it with Bun."
  fi
fi
if ! command -v opencode >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_OPENCODE" = "1" ]; then
    say "Installing OpenCode (optional)..."
    "$BUN_BIN" add -g opencode-ai >/dev/null 2>&1 || warn "opencode install failed - the 'opencode' agent kind will be unavailable."
  else
    warn "OpenCode CLI not found. OpenCode sessions will be unavailable until you install/authenticate opencode. Re-run with LFG_INSTALL_OPENCODE=1 only if you want setup to install it with Bun."
  fi
fi
if ! command -v grok >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_GROK" = "1" ]; then
    say "Installing Grok CLI (optional)..."
    curl -fsSL https://x.ai/cli/install.sh | bash || warn "Grok CLI install failed - the 'grok' agent kind will be unavailable."
  else
    warn "Grok CLI not found. Grok sessions will be unavailable until you install/authenticate grok. Re-run with LFG_INSTALL_GROK=1 only if you want setup to install it with Bun."
  fi
fi
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

if ! has_cursor_cli; then
  if [ "$LFG_INSTALL_CURSOR" = "1" ]; then
    say "Installing Cursor CLI (optional)..."
    curl -fsSL https://cursor.com/install | bash || warn "Cursor CLI install failed - the 'cursor' agent kind will be unavailable."
  else
    warn "Cursor CLI not found. Cursor sessions will be unavailable until you install/authenticate cursor-agent. Re-run with LFG_INSTALL_CURSOR=1 only if you want setup to run Cursor's installer."
  fi
fi
if ! command -v hermes >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_HERMES" = "1" ]; then
    say "Installing Hermes Agent (optional)..."
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash || warn "Hermes install failed - the 'hermes' agent kind will be unavailable."
  else
    warn "Hermes CLI not found. Hermes sessions will be unavailable until you install/authenticate hermes. Re-run with LFG_INSTALL_HERMES=1 only if you want setup to run Nous Research's installer."
  fi
fi
if ! command -v copilot >/dev/null 2>&1; then
  if [ "$LFG_INSTALL_COPILOT" = "1" ]; then
    if [ "$LFG_COPILOT_VERSION" = "latest" ]; then
      copilot_pkg="@github/copilot"
    else
      copilot_pkg="@github/copilot@${LFG_COPILOT_VERSION}"
    fi
    say "Installing GitHub Copilot CLI ($copilot_pkg, optional)..."
    npm install -g "$copilot_pkg" >/dev/null 2>&1 || warn "Copilot CLI install failed - the 'copilot' agent kind will be unavailable. Requires Node 22+."
  else
    warn "Copilot CLI not found. Copilot sessions will be unavailable until you install/authenticate copilot. Re-run with LFG_INSTALL_COPILOT=1 only if you want setup to install it via npm (requires Node 22+). Pin a specific version with LFG_COPILOT_VERSION."
  fi
fi

# ---- 4. fetch lfg (bundled release tarball, or git clone for dev) ----
# A git checkout always wins - `lfg setup` from inside a dev clone updates via
# git, never clobbering it with a release tarball.
if [ -d "$LFG_DIR/.git" ]; then
  LFG_INSTALL_MODE="source"
fi

if [ "$LFG_INSTALL_MODE" = "source" ]; then
  if [ -d "$LFG_DIR/.git" ]; then
    say "Updating OMG at ${LFG_DIR} (git)..."
    git -C "$LFG_DIR" pull --ff-only || warn "git pull skipped (local changes?)"
  else
    say "Cloning OMG into ${LFG_DIR} (git)..."
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
    if curl -fSL "$URL" -o "$attempt" && [ -s "$attempt" ]; then
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
    rm -rf "$LFG_DIR/node_modules"
    ( cd "$LFG_DIR" && unset CI && "$BUN_BIN" install --production )
  fi
fi

# ---- 6. expose the `omg` command on PATH ----
# Both names point at the same CLI: `omg` is what this installs as, and `lfg`
# stays behind it so existing scripts, cron entries and muscle memory keep
# working on a box that upgrades into the new name.
mkdir -p "$HOME/.local/bin"
ln -sf "$LFG_DIR/src/cli.ts" "$HOME/.local/bin/omg"
ln -sf "$LFG_DIR/src/cli.ts" "$HOME/.local/bin/lfg"
chmod +x "$LFG_DIR/src/cli.ts" 2>/dev/null || true

install_lfg_mcp() {
  [ "$LFG_INSTALL_MCP" = "1" ] || return 0
  local mcp_args=("$BUN_BIN" "$LFG_DIR/src/cli.ts" "mcp")
  local installed=0
  if command -v claude >/dev/null 2>&1; then
    say "Registering OMG MCP with Claude..."
    claude mcp remove lfg -s user >/dev/null 2>&1 || true
    if claude mcp add -s user lfg -- "${mcp_args[@]}" >/dev/null 2>&1; then
      installed=1
    else
      warn "Could not register OMG MCP with Claude. Open Settings -> Coding agents in OMG and run Install MCP after Claude is authenticated."
    fi
  fi
  if command -v codex >/dev/null 2>&1; then
    say "Registering OMG MCP with Codex..."
    codex mcp remove lfg >/dev/null 2>&1 || true
    if codex mcp add lfg -- "${mcp_args[@]}" >/dev/null 2>&1; then
      installed=1
    else
      warn "Could not register OMG MCP with Codex. Open Settings -> Coding agents in OMG and run Install MCP after Codex is authenticated."
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
seed_env() { grep -qE "^(OMG_|LFG_)$1=" "$LFG_DIR/.env" || echo "OMG_$1=$2" >> "$LFG_DIR/.env"; }
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

# ---- 8. Tailscale ----
if ! command -v tailscale >/dev/null 2>&1; then
  if [ "$OS_NAME" = "Linux" ]; then
    say "Installing Tailscale..."
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    warn "Tailscale CLI not found. Install Tailscale for macOS to enable tailnet access, then re-run setup."
  fi
fi
if command -v tailscale >/dev/null 2>&1 && ! tailscale status >/dev/null 2>&1; then
  say "Joining your tailnet..."
  if [ -z "$TS_AUTHKEY" ]; then
    if [ -t 0 ]; then
      read -rsp "Tailscale auth key (tskey-auth-...): " TS_AUTHKEY; echo
    elif [ "$OS_NAME" = "Darwin" ]; then
      warn "No tailnet session and no TS_AUTHKEY; skipping Tailscale setup on macOS."
    else
      die "No tailnet session and no TTY. Re-run with TS_AUTHKEY=tskey-auth-... prefixed."
    fi
  fi
  if [ -n "$TS_AUTHKEY" ]; then
    tailscale_sudo up --authkey "$TS_AUTHKEY" --ssh
    unset TS_AUTHKEY
  fi
fi

install_linux_service() {
  say "Installing the systemd user service (${SERVICE})..."
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$SERVICE-agents.slice" <<'UNIT'
[Unit]
Description=OMG managed agent memory boundary

[Slice]
# Keep reclaim local to the swarm. memory.high throttles first; memory.max is
# the last-resort cgroup OOM boundary. Idle anonymous pages may use swap.
MemoryHigh=4G
MemoryMax=5G
UNIT
  cat > "$UNIT_DIR/$SERVICE.service" <<UNIT
[Unit]
Description=lfg - self-hosted AI coding agent control plane
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
  warn "Skipping Tailscale Serve because LFG_TAILSCALE_SERVE=$LFG_TAILSCALE_SERVE."
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
  warn "Tailscale is not connected; OMG will be available on this machine at http://127.0.0.1:$LFG_PORT."
fi

# ---- done ----
URL=""
if command -v tailscale >/dev/null 2>&1; then
  URL="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//' || true)"
fi
echo
if [ "$OS_NAME" = "Linux" ]; then
  say "Done. OMG is running as a systemd user service."
else
  say "Done. OMG is running as a launchd user service."
fi
[ "$TAILSCALE_SERVE_CONFIGURED" = "1" ] && [ -n "${URL:-}" ] && echo "    Web UI (tailnet only):  https://$URL"
# The named host is an /etc/hosts mapping to 127.0.0.1, so it reaches the
# loopback-pinned service from this machine only. Lead with it when it is
# actually resolvable, and always print a bare loopback URL underneath so there
# is a working link even when the hosts file could not be written.
if [ "$LOCAL_HOSTNAME_READY" = "1" ]; then
  echo "    Local Web UI:         http://$LFG_LOCAL_HOSTNAME:$LFG_PORT"
  echo "    Local Web UI (direct): http://localhost:$LFG_PORT"
else
  echo "    Local Web UI:         http://127.0.0.1:$LFG_PORT"
  echo "    Local Web UI (named): http://localhost:$LFG_PORT"
fi
if [ "$TAILSCALE_SERVE_CONFIGURED" = "1" ]; then
  echo "    Tailscale cleanup:    sudo tailscale serve --https=$LFG_TAILSCALE_HTTPS_PORT off"
else
  echo "    Tailscale setup:      OMG_TAILSCALE_SERVE=1 omg setup"
fi
echo
cat <<NEXT

Next steps:
  1. Authenticate Claude once (interactive, one-time):
       claude            # complete the browser OAuth, or set ANTHROPIC_API_KEY in $LFG_DIR/.env
  2. Edit $LFG_DIR/.env for optional integrations (WhatsApp, GitHub token, etc.).
NEXT

if [ "$OS_NAME" = "Linux" ]; then
  cat <<NEXT
  3. Restart after any change:  systemctl --user restart $SERVICE
  4. Logs:                      journalctl --user -u $SERVICE -f

The UI is reachable only from devices on your tailnet. Do NOT open port $LFG_PORT
or 443 to the public internet - Tailscale handles ingress over WireGuard.
NEXT
else
  cat <<NEXT
  3. Restart after any change:  launchctl kickstart -k gui/$(id -u)/$SERVICE_LABEL
  4. Logs:                      tail -f "$HOME/Library/Logs/$SERVICE.err.log"

Keep the UI bound to loopback unless you are fronting it with Tailscale.
NEXT
fi
