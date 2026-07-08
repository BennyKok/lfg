# lfg

Run AI coding agents on your own machine, from anywhere.

[![Deploy on omg](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/deploy?repo=github.com/BennyKok/lfg)

<a href="https://lfg.apps.omg.dev">
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-icon.png" alt="lfg icon" width="96" />
</a>

`lfg` turns a Linux box or macOS workstation into a private control plane for
Claude Code, Codex, OpenCode, Grok, and Hermes. It starts each agent in a long-lived `tmux`
session, streams the transcript to a web UI, and lets you answer prompts or steer
work from your phone or laptop.

**Website:** [lfg.apps.omg.dev](https://lfg.apps.omg.dev)

## Why lfg?

- **Run agents where your code lives.** Sessions execute on your machine, in your
  repos, with your local CLIs and credentials.
- **Use a real web UI.** Launch sessions, watch output, answer permission
  prompts, switch projects, and resume work from an installable PWA.
- **Keep it private.** The server binds to loopback by default and is designed to
  be exposed through Tailscale, not the public internet.
- **Automate repo checks.** Optional markdown-defined agents can collect git,
  repo, GitHub, model, or security context and produce reports.

## Screenshots

<p>
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-1.jpg" alt="lfg web UI screenshot" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-2.jpg" alt="lfg session view screenshot" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-3.jpg" alt="lfg mobile control screenshot" width="31%" />
</p>

The images are stored in this repo instead of hotlinked, so the README renders
reliably on GitHub.

## Requirements

- [Bun](https://bun.sh)
- `tmux`
- `git`
- At least one supported agent CLI on `PATH`:
  - `claude`
  - `codex`
  - `opencode`
  - `cursor-agent` (Cursor CLI)
  - `grok`
  - `hermes`
- Optional: [Tailscale](https://tailscale.com) for private remote access

## Quick Start

Install on an Ubuntu/Debian VPS or macOS workstation:

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh | bash
```

For a non-interactive Tailscale setup:

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh \
  | TS_AUTHKEY=tskey-auth-xxxx bash
```

The setup script downloads the latest release, installs production dependencies,
writes `.env`, and starts the server as a user service bound to loopback.
When Claude or Codex is already installed, setup also registers the local LFG MCP
server with that CLI. You can verify or re-run this later in **Settings →
Coding agents**.

To expose the UI over your private tailnet, opt in to Tailscale Serve:

```bash
LFG_TAILSCALE_SERVE=1 lfg setup
```

## One-click Launch

[![Deploy on omg](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/deploy?repo=github.com/BennyKok/lfg)

OMG is the fastest hosted workspace path for `lfg`. The button passes this
GitHub repo to OMG, signs you in if needed, creates an LFG sandbox from the
prebuilt `lfg` template, starts `lfg serve` on port `8766`, and opens the
workspace URL.

On a fresh workspace, open **Settings → Coding agents** in LFG. That screen
checks whether Claude, Codex, OpenCode, Hermes, or Grok is installed and signed
in, and it can run the installer for supported CLIs. OAuth-based CLIs still need
you to complete their normal terminal/browser login once, or you can configure
API-key based providers with environment variables such as `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY`.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/BennyKok/lfg)

Railway is useful for a hosted demo, but `lfg` works best on the machine that
has your repos, `tmux`, and authenticated agent CLIs. See
[deploy/railway](./deploy/railway/README.md) for details.

The shared [Dockerfile](./Dockerfile) also works as the base for
[Fly.io](./deploy/fly/README.md), [Render](./deploy/render/README.md),
[DigitalOcean](./deploy/digitalocean/README.md), and
[Koyeb](./deploy/koyeb/README.md). These PaaS targets are best for demos or
private-network deployments; a VPS remains the cleanest production-style target.
Because the Vibes SDK path is not live for source installs yet, the Dockerfile
installs the published bundled release (`lfg-bundle.tar.gz`) instead of building
from the GitHub source tree. Publish a bundle with `scripts/release.sh <tag>`
before relying on one-click cloud deploys.

Maintainer convention: when asking an agent to "deploy", that means make the
current changes visible in the running/dev instance, including rebuilds or
service restarts as needed. Say "release" when you want a new tag and published
`lfg-bundle.tar.gz`.

For Hetzner, use the cloud-init template in
[deploy/hetzner](./deploy/hetzner/README.md). Hetzner's official deploy button
only preselects Hetzner App images, so the repo ships a first-boot installer
instead.

OMG user requirements:

- OMG account. The generic deploy route prompts for sign-in before it creates
  anything.
- During the preview, this deploy path is available on free accounts. Billing
  gates may change later.
- The hosted LFG workspace starts with no personal agent CLI sessions. Use LFG's
  Coding agents settings to install/check CLIs, then finish the provider login
  inside the workspace.
- Keep secrets scoped to that workspace. Prefer provider OAuth where available,
  or set API keys only when you intend the hosted workspace to use them.

Railway user requirements:

- Railway account and GitHub access to this repo.
- Keep Public Networking disabled unless you put auth in front of `lfg`.
- For Tailscale access, add Railway's Tailscale router as a second service and
  put `TS_AUTHKEY` on that router service.
- Optional provider keys in Railway variables, such as `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, or `ELEVENLABS_API_KEY`.

Hetzner user requirements:

- Hetzner Cloud account, SSH public key, and either the `hcloud` CLI or Console.
- Tailscale account plus an ephemeral/preauthorized auth key for unattended
  setup. The installer joins the server with `tailscale up --authkey ...` and
  exposes the loopback-only UI through `tailscale serve`.
- After boot, authenticate `claude`, `codex`, `opencode`, Cursor CLI, or `hermes` on the server, or
  configure API-key based providers in `.env`.

## Local Development

```bash
git clone https://github.com/BennyKok/lfg.git
cd lfg
bun install
cp .env.example .env
bun run serve
```

Open `http://127.0.0.1:8766`.

Authenticate the agent CLI you want to use, for example by running `claude` once
and completing OAuth, or by setting the required API key in `.env`.

## Commands

```bash
bun run serve                  # web UI + control server
bun run agents -- list         # list markdown-defined agents
bun run agents -- run <name>   # run an insight agent
bun run subagent -- models     # list runtime sub-agent providers/models
bun run subagent -- create --prompt "..." --agent codex-aisdk
bun run mcp                    # stdio MCP server for LFG session tools
bun run whatsapp -- run        # optional WhatsApp sidecar
bun run setup                  # rerun provisioning/update flow
```

Installed release builds expose the same commands through `lfg`.

The MCP server talks to the local `lfg serve` API and exposes tools such as
`lfg_list_sessions`, `lfg_get_session_messages`, `lfg_send_session_message`,
`lfg_create_subagent`, and `lfg_list_subagents`. Use it from an MCP client with
`lfg mcp` or `bun run mcp`.

## Configuration

Configuration lives in `.env`; see [`.env.example`](./.env.example).

Common settings:

| Variable | Purpose |
| --- | --- |
| `LFG_HOST` | Bind address. Keep `127.0.0.1` unless you know the risk. |
| `LFG_PORT` | Web UI and API port. Defaults to `8766`. |
| `LFG_REPOS_ROOT` | Directory scanned for git repos. |
| `LFG_CLAUDE_PATH` | Override the `claude` binary path. |
| `LFG_CODEX_PATH` | Override the `codex` binary path. |
| `LFG_OPENCODE_PATH` | Override the `opencode` binary path. |
| `LFG_CURSOR_PATH` | Override the Cursor CLI binary path (`cursor-agent`, or a non-Grok `agent`). |
| `LFG_HERMES_PATH` | Override the `hermes` binary path. |
| `LFG_HERMES_PROVIDER` | Optional provider override passed to `hermes chat --provider`; empty uses Hermes' configured/default provider. |
| `ANTHROPIC_API_KEY` | Optional API key for Claude SDK-backed flows. |
| `LFG_WHATSAPP_*` | Optional WhatsApp bridge settings. |
| `LFG_INSTALL_CHANNEL` | Optional install-channel override: `source`, `release`, or `container`. Normally written by setup/container deploys. |

## Security

`lfg` launches AI agents with shell access on your machine. The control API is
unauthenticated by design because it is meant to run on loopback and be accessed
privately through Tailscale.

Do not expose `lfg` directly to the public internet. Read
[SECURITY.md](./SECURITY.md) before sharing access.

## Project Layout

```text
src/                 CLI, server, sessions, tmux, agents, integrations
web/                 React/Vite PWA
agents/              Example markdown-defined insight agents
scripts/setup.sh     Installer/provisioning script
scripts-internal/    Operator-only helpers (gitignored — see CONTRIBUTING.md)
deploy/              Optional voice, STT, Modal, and ops deployments
docs/                Notes, designs, and future public images
```

## Contributing

Issues and pull requests are welcome. Please read
[CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md) first.

## License

[MIT](./LICENSE)
