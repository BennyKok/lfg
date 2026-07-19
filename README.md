# lfg

Run AI coding agents on your own machine, from anywhere.

[![Deploy on omg](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/sandbox/templates/lfg)

<a href="https://lfg.apps.omg.dev">
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-icon.png" alt="lfg icon" width="96" />
</a>

`lfg` turns a Linux box or macOS workstation into a private control plane for
Claude Code, Codex, OpenCode, Cursor, Grok, Hermes, Pi, and GitHub Copilot. It
starts each agent in a long-lived `tmux` session, streams the transcript to a
web UI, and lets you answer prompts or steer work from your phone or laptop.

**Website:** [lfg.apps.omg.dev](https://lfg.apps.omg.dev)

## Why lfg?

- **Run agents where your code lives.** Sessions execute on your machine, in your
  repos, with your local CLIs and credentials — not a remote sandbox you have to
  keep in sync.
- **One UI for every harness.** Switch agents and models per session, resume
  work, answer permission prompts, and manage projects from an installable PWA.
- **Keep it private.** The server binds to loopback by default and is designed to
  be exposed through Tailscale, not the public internet.
- **Show the work.** Agents can display verification media, publish updatable
  HTML dashboards, and post finished results to the Shipped feed.
- **Delegate with lineage.** LFG MCP tools spawn subagents that stay visible in
  the UI, inherit parent context, and report progress back.
- **Automate repo checks.** Optional markdown-defined agents collect git, repo,
  GitHub, model, or security context and produce scheduled reports.

## Screenshots

<p>
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-1.jpg" alt="lfg web UI screenshot" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-2.jpg" alt="lfg scheduled agents screenshot" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-3.jpg" alt="lfg usage limits screenshot" width="31%" />
</p>

Images live in this repo (not hotlinked from elsewhere) so the README renders
reliably on GitHub.

## Requirements

- [Bun](https://bun.sh)
- `tmux`
- `git`
- At least one supported coding agent:
  - `claude` — Claude Code CLI
  - `codex` — OpenAI Codex CLI
  - `opencode` — OpenCode CLI
  - `cursor-agent` — Cursor CLI
  - `grok` — Grok CLI
  - `hermes` — Hermes Agent
  - `copilot` — GitHub Copilot CLI (Node 22+)
  - **Pi** — ships bundled with LFG (`@mariozechner/pi-coding-agent`); no
    separate CLI install. Auth via `ANTHROPIC_API_KEY` or `~/.pi/agent/auth.json`
- Optional: [Tailscale](https://tailscale.com) for private remote access

## Quick Start

Install on an Ubuntu/Debian VPS or macOS workstation:

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh | bash
```

For a non-interactive Tailscale join:

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh \
  | TS_AUTHKEY=tskey-auth-xxxx bash
```

The setup script downloads the latest release, installs production dependencies,
writes `.env`, and starts the server as a user service bound to loopback. When
Claude or Codex is already installed, setup also registers the local LFG MCP
server with that CLI. **Settings → Coding agents → Install MCP** verifies and
registers LFG MCP with Claude, Codex, OpenCode, Grok, and Cursor when those
CLIs are present (Hermes, Copilot, and Pi have no MCP registration surface).

To expose the UI over your private tailnet:

```bash
LFG_TAILSCALE_SERVE=1 lfg setup
```

Open **Settings → Coding agents** to install or check CLIs. OAuth-based agents
still need a one-time terminal/browser login; API-key providers can use env vars
such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## One-click & cloud deploy

[![Deploy on omg](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/sandbox/templates/lfg)

**[OMG](https://omg.dev/sandbox/templates/lfg)** is the fastest hosted workspace
path: it creates a sandbox from the LFG template, starts `lfg serve` on port
`8766`, and opens the workspace URL. Fresh workspaces start with no personal
agent sessions — use **Settings → Coding agents** to install and sign in.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/BennyKok/lfg)

The shared [Dockerfile](./Dockerfile) also works for
[Railway](./deploy/railway/README.md), [Fly.io](./deploy/fly/README.md),
[Render](./deploy/render/README.md), [DigitalOcean](./deploy/digitalocean/README.md),
and [Koyeb](./deploy/koyeb/README.md). For Hetzner, use the cloud-init template in
[deploy/hetzner](./deploy/hetzner/README.md).

These PaaS targets are best for demos or private-network deployments. Day-to-day
agent work is happiest on the machine that already has your repos, `tmux`, and
authenticated CLIs. A VPS remains the cleanest production-style target.

The Dockerfile installs the published bundle (`lfg-bundle.tar.gz`) rather than
building from the GitHub source tree (the Vibes SDK path is not live for source
installs yet). Publish a bundle with `scripts/release.sh <tag>` before relying
on one-click cloud deploys.

**Maintainer note:** “deploy” means make current changes visible in the running
instance (rebuild/restart as needed). “release” means cut a tag and publish
`lfg-bundle.tar.gz`.

Platform-specific account, networking, and secret requirements live in each
`deploy/*/README.md`. In short: keep public networking off unless you put auth
in front of `lfg`, prefer Tailscale for remote access, and scope provider keys
to that environment only.

## Local Development

```bash
git clone https://github.com/BennyKok/lfg.git
cd lfg
bun install
cp .env.example .env
bun run serve
```

Open `http://127.0.0.1:8766`.

For UI hot reload (proxies `/api` to the Bun server):

```bash
cd web && bun install && bun run dev
```

Authenticate the agent CLI you want to use (for example run `claude` once and
complete OAuth), or set the required API key in `.env`.

## Commands

```bash
bun run serve                  # web UI + control server
bun run agents -- list         # list markdown-defined insight agents
bun run agents -- run <name>   # run an insight agent
bun run subagent -- models     # list runtime sub-agent providers/models
bun run subagent -- create --prompt "..." --agent codex-aisdk
bun run mcp                    # stdio MCP server for LFG session tools
bun run whatsapp -- run        # optional WhatsApp sidecar
bun run setup                  # rerun provisioning/update flow
```

Installed release builds expose the same surface as `lfg <command>`.

### MCP tools

`lfg mcp` (or `bun run mcp`) talks to the local `lfg serve` API. Prefer LFG’s
own subagent tools over a client’s generic “spawn agent” helper so children stay
visible, inherit parent/user context, and can run on any configured harness.

| Area | Tools |
| --- | --- |
| Sessions | `lfg_list_sessions`, `lfg_get_session_tree`, `lfg_get_session_messages`, `lfg_send_session_message` |
| Presentation | `lfg_display_image`, `lfg_display_video`, `lfg_publish_artifact`, `lfg_refresh_artifact`, `lfg_ship` |
| Delegation | `lfg_create_subagent`, `lfg_delegate_to_agent`, `lfg_delegate_design_task`, `lfg_delegate_backend_task`, `lfg_list_subagents`, `lfg_reparent_session` |
| Human / advisor | `lfg_ask_user`, `lfg_ask_question` |
| Catalog | `lfg_capabilities`, `lfg_list_repos`, `lfg_list_models` |

Managed sessions launched with an initial task receive a versioned **LFG runtime
contract** (when to show media, publish artifacts, ask the user, delegate, or
ship). Sessions started on an older contract are marked in the UI so they can be
closed and resumed to pick up the current tool catalog.

Subagents may nest up to four levels. Each child is expected to send
`[subagent progress]` updates and one terminal
`[subagent complete]` / `[subagent blocked]` / `[subagent failed]` message to
its parent.

Backend diagnostics append to `data/logs/trace-YYYY-MM-DD.jsonl` (API timings,
transcript indexing, live stream stalls, send queue state).

## Configuration

Configuration lives in `.env`; see [`.env.example`](./.env.example).

| Variable | Purpose |
| --- | --- |
| `LFG_HOST` | Bind address. Keep `127.0.0.1` unless you know the risk. |
| `LFG_PORT` | Web UI and API port. Defaults to `8766`. |
| `LFG_REPOS_ROOT` | Directory scanned for git repos. |
| `LFG_CLAUDE_PATH` | Override the `claude` binary path. |
| `LFG_CODEX_PATH` | Override the `codex` binary path. |
| `LFG_OPENCODE_PATH` | Override the `opencode` binary path. |
| `LFG_CURSOR_PATH` | Override the Cursor CLI path (`cursor-agent`, or a non-Grok `agent`). |
| `LFG_HERMES_PATH` | Override the `hermes` binary path. |
| `LFG_HERMES_PROVIDER` | Optional provider override for `hermes chat --provider`. |
| `LFG_PI_PATH` | Override the bundled Pi CLI path. |
| `LFG_PI_PROFILE_DIR` | Optional [custom agent profile](./docs/custom-agent-profiles.md) for Pi (extra system prompt, skills, display name). |
| `LFG_COPILOT_PATH` | Override the `copilot` binary path. Auth via interactive `/login` or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` (Copilot Requests scope). |
| `LFG_COPILOT_ALLOW_ALL_TOOLS` | Set to `1` to pass `--allow-all-tools` when spawning Copilot. Off by default; enable only when the host is the trust boundary. |
| `LFG_COPILOT_VERSION` | Pinned `@github/copilot` version for `LFG_INSTALL_COPILOT=1` (default `1.0.71`). Prefer a known-good pin over floating `latest`. |
| `ANTHROPIC_API_KEY` | Optional API key for Claude / Pi flows. |
| `LFG_WHATSAPP_*` | Optional WhatsApp bridge settings. |
| `LFG_INSTALL_CHANNEL` | Install channel: `source`, `release`, or `container`. Usually set by setup/deploy. |

## Security

`lfg` launches AI agents with shell access on your machine. The control API is
unauthenticated by design because it is meant to run on loopback and be reached
privately through Tailscale.

**Do not expose `lfg` directly to the public internet.** Read
[SECURITY.md](./SECURITY.md) before sharing access.

## Project Layout

```text
src/                 CLI, server, sessions, tmux, agents, MCP, integrations
web/                 React/Vite PWA
agents/              Example markdown-defined insight agents
scripts/setup.sh     Installer / provisioning
scripts/             Release, fleet, and smoke helpers
scripts-internal/    Operator-only helpers (gitignored — see CONTRIBUTING.md)
deploy/              Cloud, voice, STT, and ops deployments
docs/                Design notes, agent profiles, README images
```

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md) first.

## License

[MIT](./LICENSE)
