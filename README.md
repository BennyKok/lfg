<a href="https://omg.dev">
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/lfg-icon.png" alt="lfg icon" width="96" />
</a>

# lfg

**Run your AI coding agents on your own machine — and drive them from your phone.**

*The open-source agent control plane behind [omg.dev](https://omg.dev). The CLI is `lfg`.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/BennyKok/omg.dev?style=flat)](https://github.com/BennyKok/omg.dev/stargazers)
[![npm](https://img.shields.io/npm/v/@omg-dev/cli?label=%40omg-dev%2Fcli)](https://www.npmjs.com/package/@omg-dev/cli)

[Quick start](#quick-start) · [Why lfg](#why-lfg) · [Agents](#connect-a-coding-agent) · [Remote access](#reach-it-from-your-phone) · [Security](#security)

<p>
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/lfg-screenshot-1.jpg" alt="lfg web UI" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/lfg-screenshot-2.jpg" alt="lfg scheduled agents" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/lfg-screenshot-3.jpg" alt="lfg usage limits" width="31%" />
</p>

---

Running one coding agent in a terminal is fine. Running five is not: they die
when you close the laptop, you can't tell which one is stuck waiting on a
permission prompt, and you have to be at your desk to answer it.

`lfg` turns a Linux box or macOS workstation into a private control plane for
Claude Code, Codex, OpenCode, Cursor, Grok, Hermes, Pi, and GitHub Copilot. Each
agent runs in a long-lived `tmux` session that survives disconnects. The
transcript streams to a web UI you can install as a PWA — so you can check on
work, answer prompts, and steer from your phone.

**You bring your own agent accounts.** `lfg` drives CLIs you already own and
authenticate. It does not resell tokens and has no model of its own.

## Quick start

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/omg.dev/main/scripts/setup.sh | bash
```

Then open **http://127.0.0.1:8766**.

That's the whole install. The script provisions Bun, `tmux`, and `git`,
downloads the latest release, writes `.env`, and starts `lfg` as a user service
bound to loopback. On a fresh Ubuntu/Debian box, add
`LFG_INSTALL_SYSTEM_DEPS=1` so it may `apt-get` the base packages.

Next: [connect a coding agent](#connect-a-coding-agent) so you have something to
run, then [reach it from your phone](#reach-it-from-your-phone).

### Run from source

```bash
git clone https://github.com/BennyKok/omg.dev.git
cd omg.dev
bun install
cp .env.example .env
bun run serve
```

Open `http://127.0.0.1:8766`. For UI hot reload (proxies `/api` to the Bun
server): `cd web && bun install && bun run dev`.

### What you need

The installer handles all of this; this list is for the from-source path and for
the curious.

- [Bun](https://bun.sh), `tmux`, `git`
- At least one coding agent CLI — see [below](#connect-a-coding-agent)
- Optional: [Tailscale](https://tailscale.com) for private remote access

## Why lfg?

- **Run agents where your code lives.** Sessions execute on your machine, in
  your repos, with your local CLIs and credentials — not a remote sandbox you
  have to keep in sync.
- **Bring your own accounts.** Claude, Codex, OpenCode, Cursor, Grok, Hermes,
  Copilot, and Pi all run on subscriptions and keys you already have.
- **One UI for every harness.** Switch agents and models per session, resume
  work, answer permission prompts, and manage projects from an installable PWA.
- **Survive the lid closing.** `tmux`-backed sessions keep running when you
  disconnect, and pick up exactly where they were when you come back.
- **Keep it private.** The server binds to loopback by default and is designed
  to be exposed through Tailscale, not the public internet.
- **Delegate with lineage.** LFG MCP tools spawn subagents that stay visible in
  the UI, inherit parent context, and report progress back.
- **Show the work.** Agents can display verification media, publish updatable
  HTML dashboards, and post finished results to the Shipped feed.
- **Automate repo checks.** Optional markdown-defined agents collect git, repo,
  GitHub, model, or security context and produce scheduled reports.

## Connect a coding agent

`lfg` drives agent CLIs that you own and authenticate. Open **Settings → Coding
agents** in the web UI to install one, check its binary path and auth state, and
register LFG's MCP server with it.

| Agent | Command | Notes |
| --- | --- | --- |
| Claude Code | `claude` | Installed by the setup script |
| OpenAI Codex | `codex` | |
| OpenCode | `opencode` | |
| Cursor | `cursor-agent` | |
| Grok | `grok` | |
| Hermes | `hermes` | |
| GitHub Copilot | `copilot` | Needs Node 22+ |
| Pi | *bundled* | Ships with LFG (`@earendil-works/pi-coding-agent`); no separate install |

OAuth-based agents need a one-time terminal or browser login. API-key providers
read env vars such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from `.env`. Pi
authenticates via `ANTHROPIC_API_KEY` or `~/.pi/agent/auth.json`.

**Settings → Coding agents → Install MCP** registers LFG MCP with Claude, Codex,
OpenCode, Grok, and Cursor when those CLIs are present. (Hermes, Copilot, and Pi
have no MCP registration surface.) The setup script does this automatically for
Claude and Codex when they are already installed.

## Reach it from your phone

`lfg` binds to loopback and has **no authentication of its own** — it trusts the
network you put it behind. There are two supported ways to reach it remotely:

**Tailscale (recommended).** The simplest choice if you only open the UI from
your own devices:

```bash
LFG_TAILSCALE_SERVE=1 lfg setup
```

**A relay (experimental).** For the case Tailscale can't cover — rendering a
session from your box on a *public* web origin:

```bash
LFG_RELAY_URL=wss://your-relay.example/connect lfg connect ABC123   # outbound only, no inbound port
```

No relay ships with LFG itself; the protocol is generic and any operator can
implement it. [omg.dev](https://omg.dev) runs one, and its CLI configures the
pairing for you in a single command:

```bash
npm install --global @omg-dev/cli
omg login
omg connect        # installs LFG if needed, then pairs and connects
```

Full comparison, the pairing flow, and opt-in session lifecycle events:
**[docs/remote-access.md](./docs/remote-access.md)**.

Do not put `lfg` on the public internet without your own auth in front of it.
See [Security](#security).

## Security

`lfg` launches AI agents with shell access on your machine. The control API is
unauthenticated by design because it is meant to run on loopback and be reached
privately through Tailscale.

**Do not expose `lfg` directly to the public internet.** Read
[SECURITY.md](./SECURITY.md) before sharing access.

## Don't want to run a box?

[![Deploy on omg.dev](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/sandbox/templates/lfg)

[omg.dev](https://omg.dev) is the hosted version, run by the same author — a
cloud machine with `lfg` already running, so there's nothing to install and no
server to provision. There's a free tier, and it's entirely optional: everything
above works forever without an account.

One click on [omg.dev/sandbox/templates/lfg](https://omg.dev/sandbox/templates/lfg)
gives you a workspace with the LFG web UI already up. Workspaces hibernate when
idle and wake on the same URL.

> **Which should I pick?** Install locally if you want agents working on the
> repos and authenticated CLIs already on your machine — that is what `lfg` is
> for. Use omg.dev to try it in seconds, or when you would rather not run a box
> at all. A fresh hosted workspace has no agent CLIs signed in, and agents work
> on repos you clone *into* it. More detail in [deploy/omg](./deploy/omg/README.md).

## Managing an install

From LFG itself:

```bash
lfg setup                     # update and re-run idempotent provisioning
lfg uninstall                 # remove LFG; keep sessions and config for reinstall
lfg uninstall --purge --yes   # also permanently delete sessions and config
```

Or through the omg.dev CLI, which wraps the same lifecycle:

```bash
omg computer setup                     # install LFG (no omg.dev account needed)
omg computer status                    # inspect the local install and pairing
omg computer update                    # update an existing LFG installation
omg computer uninstall                 # remove LFG; preserve sessions and config
omg computer uninstall --purge --yes   # also permanently delete local LFG data
```

`update` never installs a missing computer, and `uninstall` delegates cleanup to
LFG instead of guessing which files it owns. Removal stops LFG's service and
deletes its command, MCP registrations, and release files. Shared prerequisites
such as Bun, Tailscale, `tmux`, and coding-agent CLIs are left alone; source
checkouts are preserved unless explicitly purged.

## Commands

```bash
lfg serve                      # web UI + control server
lfg setup                      # rerun provisioning/update flow
lfg uninstall                  # remove LFG while preserving sessions and config
lfg connect <code>             # reach this box through a relay (see docs/remote-access.md)
lfg mcp                        # stdio MCP server for LFG session tools
lfg agents list                # list markdown-defined insight agents
lfg agents run <name>          # run an insight agent
lfg subagent models            # list runtime sub-agent providers/models
lfg subagent create --prompt "..." --agent codex-aisdk
```

From a source checkout, use `bun run <command>` (e.g. `bun run serve`) — the
surface is identical.

## MCP tools

`lfg mcp` talks to the local `lfg serve` API and exposes LFG's session tools to
any MCP client. Prefer LFG's own subagent tools over a client's generic "spawn
agent" helper so children stay visible in the UI, inherit parent and user
context, and can run on any configured harness.

| Area | Tools |
| --- | --- |
| Sessions | `lfg_list_sessions`, `lfg_get_session_tree`, `lfg_get_session_messages`, `lfg_send_session_message`, `lfg_close_session` |
| Origin delivery | `lfg_send_to_origin` |
| Presentation | `lfg_display_image`, `lfg_display_video`, `lfg_publish_artifact`, `lfg_refresh_artifact`, `lfg_ship` |
| Delegation | `lfg_create_subagent`, `lfg_delegate_to_agent`, `lfg_delegate_design_task`, `lfg_delegate_backend_task`, `lfg_list_subagents`, `lfg_reparent_session` |
| Human input | `lfg_ask_user`, `lfg_input` |
| Catalog | `lfg_capabilities`, `lfg_list_repos`, `lfg_list_models` |

Managed sessions launched with an initial task receive a versioned **LFG runtime
contract** (when to show media, publish artifacts, ask the user, delegate, or
ship). Sessions started on an older contract are marked in the UI so they can be
closed and resumed to pick up the current tool catalog.

Subagents may nest up to four levels. Each child sends `[subagent progress]`
updates and one terminal `[subagent complete]` / `[subagent blocked]` /
`[subagent failed]` message to its parent.

## Configuration

Configuration lives in `.env`. **[`.env.example`](./.env.example) documents every
variable inline.**

Variables use the `OMG_` prefix. The older `LFG_` spelling of every name is still
read, so an existing `.env` keeps working and does not need to be migrated; when
a name is set both ways, `OMG_` wins. New installs are seeded with `OMG_`.

These are the ones most people touch:

| Variable | Purpose |
| --- | --- |
| `OMG_HOST` | Bind address. Keep `127.0.0.1` unless you know the risk. |
| `OMG_PORT` | Web UI and API port. Defaults to `8766`. |
| `OMG_REPOS_ROOT` | Directory scanned for git repos. |
| `ANTHROPIC_API_KEY` | Optional API key for Claude / Pi flows. |
| `OMG_<AGENT>_PATH` | Override a CLI's binary path (`OMG_CLAUDE_PATH`, `OMG_CODEX_PATH`, `OMG_OPENCODE_PATH`, `OMG_CURSOR_PATH`, `OMG_HERMES_PATH`, `OMG_PI_PATH`, `OMG_COPILOT_PATH`). |
| `OMG_RELAY_URL` | Relay WebSocket URL for `lfg connect`. See [docs/remote-access.md](./docs/remote-access.md). |
| `OMG_INSTALL_CHANNEL` | Install channel: `source`, `release`, or `container`. Usually set by setup/deploy. |

Other groups: agent-specific behaviour (`OMG_COPILOT_ALLOW_ALL_TOOLS`,
`OMG_HERMES_PROVIDER`, `OMG_PI_PROFILE_DIR` — see
[custom agent profiles](./docs/custom-agent-profiles.md)), relay event
forwarding (`OMG_CONNECT_EVENTS*`), backend tracing
(`OMG_TRACE_RETENTION_DAYS`, `OMG_TRACE_TRANSCRIPT_*`), and the optional
WhatsApp bridge (`OMG_WHATSAPP_*`).

Backend diagnostics append to `data/logs/trace-YYYY-MM-DD.jsonl` (API timings,
transcript indexing, live stream stalls, send queue state).

## Deploy to a cloud host

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/BennyKok/omg.dev)

The shared [Dockerfile](./Dockerfile) works for
[Railway](./deploy/railway/README.md), [Fly.io](./deploy/fly/README.md),
[Render](./deploy/render/README.md), [DigitalOcean](./deploy/digitalocean/README.md),
and [Koyeb](./deploy/koyeb/README.md). For Hetzner, use the cloud-init template
in [deploy/hetzner](./deploy/hetzner/README.md). It builds from the source tree
it is given — installs dependencies with Bun, builds the web UI, runs
`bun run serve` — so a one-click deploy builds whatever commit the platform
checks out. Nothing has to be published first.

These PaaS targets are best for demos or private-network deployments. Day-to-day
agent work is happiest on the machine that already has your repos, `tmux`, and
authenticated CLIs.

Platform-specific account, networking, and secret requirements live in each
`deploy/*/README.md`. In short: keep public networking off unless you put auth
in front of `lfg`, prefer Tailscale for remote access, and scope provider keys
to that environment only.

## Embedding LFG in your own product

Every release publishes `@lfg-dev/protocol`, `@lfg-dev/client`, `@lfg-dev/react`,
and `@lfg-dev/app` — the last being the exact full application the standalone
web UI runs. React hosts mount it with their own transport and asset origin. See
**[docs/embedding.md](./docs/embedding.md)**.

## Project layout

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

> **Repository renamed (2026-08-05).** This project now lives at
> [`github.com/BennyKok/omg.dev`](https://github.com/BennyKok/omg.dev)
> (formerly `BennyKok/lfg`). GitHub redirects the old web and git URLs; update
> bookmarks and `git remote` when convenient. The CLI is still `lfg`.

## License

[MIT](./LICENSE)
