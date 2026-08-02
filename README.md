<a href="https://omg.dev">
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-icon.png" alt="lfg icon" width="96" />
</a>

# lfg

**Run AI coding agents on your own machine, from anywhere.**

`lfg` turns a Linux box or macOS workstation into a private control plane for
Claude Code, Codex, OpenCode, Cursor, Grok, Hermes, Pi, and GitHub Copilot. It
starts each agent in a long-lived `tmux` session, streams the transcript to a
web UI, and lets you answer prompts or steer work from your phone or laptop.

[Website](https://omg.dev) · [Quick start](#quick-start) · [Security](#security) · [Contributing](./CONTRIBUTING.md)

<p>
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-1.jpg" alt="lfg web UI screenshot" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-2.jpg" alt="lfg scheduled agents screenshot" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/lfg/main/docs/images/lfg-screenshot-3.jpg" alt="lfg usage limits screenshot" width="31%" />
</p>

---

## Quick start

**Install it on your own machine — one command:**

```bash
curl -fsSL https://raw.githubusercontent.com/BennyKok/lfg/main/scripts/setup.sh | bash
```

Then open **http://127.0.0.1:8766**.

That's the whole install. The script provisions Bun, `tmux`, and `git`,
downloads the latest release, writes `.env`, and starts `lfg` as a user service
bound to loopback. On a fresh Ubuntu/Debian box, add
`LFG_INSTALL_SYSTEM_DEPS=1` so it may `apt-get` the base packages.

Next: [connect a coding agent](#connect-a-coding-agent) so you have something to
run, and [reach it from your phone](#reach-it-from-your-phone).

**Or try it hosted, with no install at all:**

[![Deploy on omg](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/sandbox/templates/lfg)

One click on [omg.dev](https://omg.dev/sandbox/templates/lfg) gives you a
workspace with `lfg` already running — nothing to install and no server to
provision. See [One-click setup on omg.dev](#one-click-setup-on-omgdev).

> **Which should I pick?** Install locally if you want agents working on the
> repos and authenticated CLIs already on your machine — that is what `lfg` is
> for. Use omg.dev to try it in seconds, or when you would rather not run a box
> at all.

### Run from source instead

```bash
git clone https://github.com/BennyKok/lfg.git
cd lfg
bun install
cp .env.example .env
bun run serve
```

Open `http://127.0.0.1:8766`. For UI hot reload (proxies `/api` to the Bun
server): `cd web && bun install && bun run dev`.

### What you need

The installer handles all of this for you; this list is for the from-source path
and for the curious.

- [Bun](https://bun.sh), `tmux`, `git`
- At least one coding agent CLI — see below
- Optional: [Tailscale](https://tailscale.com) for private remote access

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
network you put it behind. If you use omg.dev, its authenticated CLI is the
shortest path to the hosted relay:

```bash
omg connect                              # installs LFG if needed, then pairs and connects
```

`omg connect` discovers OMG's relay and passes a one-time code directly to
`lfg connect`, without a dashboard or clipboard step. It resumes the saved
binding on later runs. Sign in once with `omg login`; install the CLI with
`npm install --global @omg-dev/cli` if you do not already have it.

The underlying remote-access choices remain Tailscale or a relay you trust:

```bash
LFG_TAILSCALE_SERVE=1 lfg setup      # private: front it with Tailscale
```

```bash
LFG_RELAY_URL=wss://your-relay.example/connect lfg connect ABC123   # outbound relay, no inbound port
```

Tailscale is the simpler choice if you only open the UI from your own devices.
The relay (experimental) exists for the case Tailscale can't cover — rendering a
session from your box on a *public* web origin. OMG operates one that its CLI
configures for you; other operators can implement the same generic protocol.
No relay ships with LFG itself. Full comparison, the pairing flow, and opt-in
session lifecycle events:
**[docs/remote-access.md](./docs/remote-access.md)**.

Do not put `lfg` on the public internet without your own auth in front of it.
See [Security](#security).

## One-click setup on omg.dev

[![Deploy on omg](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/sandbox/templates/lfg)

**[omg.dev](https://omg.dev/sandbox/templates/lfg)** is the fastest way to try
`lfg` — one click, no local install and no server to provision:

1. Open [omg.dev/sandbox/templates/lfg](https://omg.dev/sandbox/templates/lfg)
   and sign in to OMG if prompted.
2. OMG creates a sandbox from the prebuilt `lfg` template and starts
   `lfg serve --host 0.0.0.0 --port 8766`.
3. Your browser lands on the workspace URL with the LFG web UI already running.

The template ships with `lfg` and its prerequisites installed, so none of
[What you need](#what-you-need) applies. Workspaces hibernate when idle and wake
on the same URL.

A fresh workspace intentionally has no agent CLIs signed in — use **Settings →
Coding agents** as above. Because the sandbox is a remote machine, agents work
on repos you clone *into* that workspace; to use the repos already on your own
machine, install locally instead. More detail in
[deploy/omg](./deploy/omg/README.md).

## Why lfg?

- **Run agents where your code lives.** Sessions execute on your machine, in
  your repos, with your local CLIs and credentials — not a remote sandbox you
  have to keep in sync.
- **One UI for every harness.** Switch agents and models per session, resume
  work, answer permission prompts, and manage projects from an installable PWA.
- **Keep it private.** The server binds to loopback by default and is designed
  to be exposed through Tailscale, not the public internet.
- **Show the work.** Agents can display verification media, publish updatable
  HTML dashboards, and post finished results to the Shipped feed.
- **Delegate with lineage.** LFG MCP tools spawn subagents that stay visible in
  the UI, inherit parent context, and report progress back.
- **Automate repo checks.** Optional markdown-defined agents collect git, repo,
  GitHub, model, or security context and produce scheduled reports.

## Commands

```bash
lfg serve                      # web UI + control server
lfg setup                      # rerun provisioning/update flow
lfg connect <code>             # reach this box through a relay (see docs/remote-access.md)
lfg mcp                        # stdio MCP server for LFG session tools
lfg agents list                # list markdown-defined insight agents
lfg agents run <name>          # run an insight agent
lfg subagent models            # list runtime sub-agent providers/models
lfg subagent create --prompt "..." --agent codex-aisdk
lfg whatsapp run               # optional WhatsApp sidecar
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
| Human / advisor | `lfg_ask_user`, `lfg_ask_question` |
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
variable inline** — these are the ones most people touch:

| Variable | Purpose |
| --- | --- |
| `LFG_HOST` | Bind address. Keep `127.0.0.1` unless you know the risk. |
| `LFG_PORT` | Web UI and API port. Defaults to `8766`. |
| `LFG_REPOS_ROOT` | Directory scanned for git repos. |
| `ANTHROPIC_API_KEY` | Optional API key for Claude / Pi flows. |
| `LFG_<AGENT>_PATH` | Override a CLI's binary path (`LFG_CLAUDE_PATH`, `LFG_CODEX_PATH`, `LFG_OPENCODE_PATH`, `LFG_CURSOR_PATH`, `LFG_HERMES_PATH`, `LFG_PI_PATH`, `LFG_COPILOT_PATH`). |
| `LFG_RELAY_URL` | Relay WebSocket URL for `lfg connect`. See [docs/remote-access.md](./docs/remote-access.md). |
| `LFG_INSTALL_CHANNEL` | Install channel: `source`, `release`, or `container`. Usually set by setup/deploy. |

Other groups: agent-specific behaviour (`LFG_COPILOT_ALLOW_ALL_TOOLS`,
`LFG_HERMES_PROVIDER`, `LFG_PI_PROFILE_DIR` — see
[custom agent profiles](./docs/custom-agent-profiles.md)), relay event
forwarding (`LFG_CONNECT_EVENTS*`), backend tracing
(`LFG_TRACE_RETENTION_DAYS`, `LFG_TRACE_TRANSCRIPT_*`), and the optional
WhatsApp bridge (`LFG_WHATSAPP_*`).

Backend diagnostics append to `data/logs/trace-YYYY-MM-DD.jsonl` (API timings,
transcript indexing, live stream stalls, send queue state).

## Security

`lfg` launches AI agents with shell access on your machine. The control API is
unauthenticated by design because it is meant to run on loopback and be reached
privately through Tailscale.

**Do not expose `lfg` directly to the public internet.** Read
[SECURITY.md](./SECURITY.md) before sharing access.

## Deploy to a cloud host

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/BennyKok/lfg)

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

## License

[MIT](./LICENSE)
