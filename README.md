<a href="https://omg.dev">
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/omg-icon.png" alt="OMG icon" width="96" />
</a>

# OMG

**Run your AI coding agents on your own machine — and drive them from your phone.**

*The open-source agent control plane behind [omg.dev](https://omg.dev).*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/BennyKok/omg.dev?style=flat)](https://github.com/BennyKok/omg.dev/stargazers)
[![npm](https://img.shields.io/npm/v/@omg-dev/cli?label=%40omg-dev%2Fcli)](https://www.npmjs.com/package/@omg-dev/cli)

[Quick start](#quick-start) · [Why OMG](#why-omg) · [Agents](#connect-a-coding-agent) · [Remote access](#reach-it-from-your-phone) · [Security](#security)

<p>
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/omg-screenshot-1.jpg" alt="OMG web UI" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/omg-screenshot-2.jpg" alt="OMG scheduled agents" width="31%" />
  <img src="https://raw.githubusercontent.com/BennyKok/omg.dev/main/docs/images/omg-screenshot-3.jpg" alt="OMG usage limits" width="31%" />
</p>

---

Running one coding agent in a terminal is fine. Running five is not: they die
when you close the laptop, you can't tell which one is stuck waiting on a
permission prompt, and you have to be at your desk to answer it.

OMG turns a Linux box or macOS workstation into a private control plane for
Claude Code, Codex, OpenCode, Cursor, Grok, Hermes, Pi, and GitHub Copilot. Each
agent runs in a long-lived `tmux` session that survives disconnects. The
transcript streams to a web UI you can install as a PWA — so you can check on
work, answer prompts, and steer from your phone.

**You bring your own agent accounts.** OMG drives CLIs you already own and
authenticate. It does not resell tokens and has no model of its own.

## Quick start

The `omg` CLI is the supported way to install and manage OMG:

```bash
npm install --global @omg-dev/cli && omg computer setup
```

Then open **http://omg.local:8766**.

No omg.dev account is needed for this — `omg computer setup` provisions a purely
local install. The CLI installs Bun, `tmux`, and `git`, fetches the latest
release, writes `.env`, maps `omg.local` to `127.0.0.1`, and starts OMG as a
user service bound to loopback. On a fresh Ubuntu/Debian box, add
`OMG_INSTALL_SYSTEM_DEPS=1` so it may `apt-get` the base packages.

The install lands in `~/omg` and runs as `omg.service` (launchd: `dev.omg.serve`).

> **Heads up on the first install.** Provisioning currently downloads roughly
> 2 GB of agent-runtime binaries, so on a home connection expect minutes, not
> seconds. Making this dramatically smaller is
> [active work](#making-installs-smaller) — the resolver is fast; the payload is
> not.

Next: [connect a coding agent](#connect-a-coding-agent) so you have something to
run, then [reach it from your phone](#reach-it-from-your-phone).

### Named local URL

Setup maps `omg.local` to `127.0.0.1` in `/etc/hosts`, so the UI has a stable
address without ever binding to a non-loopback interface. Both of these reach
the same server:

```text
http://omg.local:8766     # named
http://localhost:8766     # direct
```

Set `OMG_LOCAL_HOSTNAME` to choose a different name, or empty to skip the hosts
file entirely. `omg uninstall` removes the entry.

Browsers only grant "secure context" to `https://`, `localhost`, and loopback
IPs — so **install the PWA from `localhost:8766`**, not from `omg.local`, or the
service worker will not register.

### Run from source

For development and forks:

```bash
git clone https://github.com/BennyKok/omg.dev.git
cd omg.dev
bun install
cp .env.example .env
bun run serve
```

Open `http://localhost:8766`. For UI hot reload (proxies `/api` to the Bun
server): `cd web && bun install && bun run dev`.

### What you need

The CLI handles all of this; this list is for the from-source path and for the
curious.

- [Bun](https://bun.sh), `tmux`, `git`
- At least one coding agent CLI — see [below](#connect-a-coding-agent)
- Optional: [Tailscale](https://tailscale.com) for private remote access

## Why OMG?

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
- **Delegate with lineage.** OMG MCP tools spawn subagents that stay visible in
  the UI, inherit parent context, and report progress back.
- **Show the work.** Agents can display verification media, publish updatable
  HTML dashboards, and post finished results to the Shipped feed.
- **Automate repo checks.** Optional markdown-defined agents collect git, repo,
  GitHub, model, or security context and produce scheduled reports.

## Connect a coding agent

OMG drives agent CLIs that you own and authenticate. Open **Settings → Coding
agents** in the web UI to install one, check its binary path and auth state, and
register OMG's MCP server with it.

| Agent | Command | Notes |
| --- | --- | --- |
| Claude Code | `claude` | Installed by setup |
| OpenAI Codex | `codex` | |
| OpenCode | `opencode` | |
| Cursor | `cursor-agent` | |
| Grok | `grok` | |
| Hermes | `hermes` | |
| GitHub Copilot | `copilot` | Needs Node 22+ |
| Pi | *bundled* | Ships with OMG (`@earendil-works/pi-coding-agent`); no separate install |

OAuth-based agents need a one-time terminal or browser login. API-key providers
read env vars such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from `.env`. Pi
authenticates via `ANTHROPIC_API_KEY` or `~/.pi/agent/auth.json`.

**Settings → Coding agents → Install MCP** registers OMG MCP with Claude, Codex,
OpenCode, Grok, and Cursor when those CLIs are present. (Hermes, Copilot, and Pi
have no MCP registration surface.) Setup does this automatically for Claude and
Codex when they are already installed.

## Reach it from your phone

OMG binds to loopback and has **no authentication of its own** — it trusts the
network you put it behind. There are two supported ways to reach it remotely:

**Tailscale (recommended).** The simplest choice if you only open the UI from
your own devices:

```bash
OMG_TAILSCALE_SERVE=1 omg setup
```

**A relay (experimental).** For the case Tailscale can't cover — rendering a
session from your box on a *public* web origin:

```bash
OMG_RELAY_URL=wss://your-relay.example/connect omg connect ABC123   # outbound only, no inbound port
```

No relay ships with OMG itself; the protocol is generic and any operator can
implement it. [omg.dev](https://omg.dev) runs one, and the CLI configures the
pairing for you:

```bash
omg login
omg connect        # installs OMG if needed, then pairs and connects
```

Full comparison, the pairing flow, and opt-in session lifecycle events:
**[docs/remote-access.md](./docs/remote-access.md)**.

Do not put OMG on the public internet without your own auth in front of it.
See [Security](#security).

## Security

OMG launches AI agents with shell access on your machine. The control API is
unauthenticated by design because it is meant to run on loopback and be reached
privately through Tailscale.

**Do not expose OMG directly to the public internet.** Read
[SECURITY.md](./SECURITY.md) before sharing access.

## Don't want to run a box?

[![Deploy on omg.dev](https://omg.dev/deploy-badge.svg?v=2)](https://omg.dev/sandbox/templates/lfg)

[omg.dev](https://omg.dev) is the hosted version, run by the same author — a
cloud machine with OMG already running, so there's nothing to install and no
server to provision. There's a free tier, and it's entirely optional: everything
above works forever without an account.

One click gives you a workspace with the OMG web UI already up. Workspaces
hibernate when idle and wake on the same URL.

> **Which should I pick?** Install locally if you want agents working on the
> repos and authenticated CLIs already on your machine — that is what OMG is
> for. Use omg.dev to try it in seconds, or when you would rather not run a box
> at all. A fresh hosted workspace has no agent CLIs signed in, and agents work
> on repos you clone *into* it. More detail in [deploy/omg](./deploy/omg/README.md).

## Managing an install

The `omg` CLI wraps the whole lifecycle:

```bash
omg computer setup                     # install OMG (no omg.dev account needed)
omg computer status                    # inspect the local install and pairing
omg computer update                    # update an existing installation
omg computer uninstall                 # remove OMG; preserve sessions and config
omg computer uninstall --purge --yes   # also permanently delete local OMG data
```

`update` never installs a missing computer, and `uninstall` delegates cleanup to
OMG instead of guessing which files it owns. Removal stops the service and
deletes its command, MCP registrations, `/etc/hosts` entry, and release files.
Shared prerequisites such as Bun, Tailscale, `tmux`, and coding-agent CLIs are
left alone; source checkouts are preserved unless explicitly purged.

The same operations are available from inside an install:

```bash
omg setup                     # update and re-run idempotent provisioning
omg uninstall                 # remove OMG; keep sessions and config for reinstall
omg uninstall --purge --yes   # also permanently delete sessions and config
```

## Commands

```bash
omg serve                      # web UI + control server
omg setup                      # rerun provisioning/update flow
omg uninstall                  # remove OMG while preserving sessions and config
omg connect <code>             # reach this box through a relay (see docs/remote-access.md)
omg mcp                        # stdio MCP server for OMG session tools
omg agents list                # list markdown-defined insight agents
omg agents run <name>          # run an insight agent
omg subagent models            # list runtime sub-agent providers/models
omg subagent create --prompt "..." --agent codex-aisdk
```

From a source checkout, use `bun run <command>` (e.g. `bun run serve`) — the
surface is identical.

## MCP tools

`omg mcp` talks to the local `omg serve` API and exposes OMG's session tools to
any MCP client. Prefer OMG's own subagent tools over a client's generic "spawn
agent" helper so children stay visible in the UI, inherit parent and user
context, and can run on any configured harness.

| Area | Tools |
| --- | --- |
| Sessions | `omg_list_sessions`, `omg_find_sessions`, `omg_get_session_tree`, `omg_get_session_messages`, `omg_send_session_message`, `omg_close_session` |
| Origin delivery | `omg_send_to_origin` |
| Presentation | `omg_display_image`, `omg_display_video`, `omg_publish_artifact`, `omg_refresh_artifact`, `omg_delete_artifact`, `omg_ship` |
| Delegation | `omg_create_subagent`, `omg_delegate_to_agent`, `omg_delegate_design_task`, `omg_delegate_backend_task`, `omg_list_subagents`, `omg_reparent_session` |
| Auto agents | `omg_list_auto_agents`, `omg_compose_auto_agent`, `omg_save_auto_agent`, `omg_run_auto_agent`, `omg_delete_auto_agent`, `omg_list_findings`, `omg_update_finding` |
| Human input | `omg_ask_user`, `omg_input` |
| Catalog | `omg_capabilities`, `omg_list_repos`, `omg_list_models` |

Managed sessions launched with an initial task receive a versioned **OMG runtime
contract** (when to show media, publish artifacts, ask the user, delegate, or
ship). Sessions started on an older contract are marked in the UI so they can be
closed and resumed to pick up the current tool catalog.

Subagents may nest up to four levels. Each child sends `[subagent progress]`
updates and one terminal `[subagent complete]` / `[subagent blocked]` /
`[subagent failed]` message to its parent.

## Configuration

Configuration lives in `.env`. **[`.env.example`](./.env.example) documents every
variable inline.**

Variables use the `OMG_` prefix. These are the ones most people touch:

| Variable | Purpose |
| --- | --- |
| `OMG_HOST` | Bind address. Keep `127.0.0.1` unless you know the risk. |
| `OMG_PORT` | Web UI and API port. Defaults to `8766`. |
| `OMG_LOCAL_HOSTNAME` | Named local URL mapped to loopback. Defaults to `omg.local`; empty skips the hosts file. |
| `OMG_REPOS_ROOT` | Directory scanned for git repos. |
| `ANTHROPIC_API_KEY` | Optional API key for Claude / Pi flows. |
| `OMG_<AGENT>_PATH` | Override a CLI's binary path (`OMG_CLAUDE_PATH`, `OMG_CODEX_PATH`, `OMG_OPENCODE_PATH`, `OMG_CURSOR_PATH`, `OMG_HERMES_PATH`, `OMG_PI_PATH`, `OMG_COPILOT_PATH`). |
| `OMG_RELAY_URL` | Relay WebSocket URL for `omg connect`. See [docs/remote-access.md](./docs/remote-access.md). |
| `OMG_INSTALL_CHANNEL` | Install channel: `source`, `release`, or `container`. Usually set by setup/deploy. |

Other groups: agent-specific behaviour (`OMG_COPILOT_ALLOW_ALL_TOOLS`,
`OMG_HERMES_PROVIDER`, `OMG_PI_PROFILE_DIR` — see
[custom agent profiles](./docs/custom-agent-profiles.md)), relay event
forwarding (`OMG_CONNECT_EVENTS*`), backend tracing
(`OMG_TRACE_RETENTION_DAYS`, `OMG_TRACE_TRANSCRIPT_*`), and the optional
WhatsApp bridge (`OMG_WHATSAPP_*`).

Backend diagnostics append to `data/logs/trace-YYYY-MM-DD.jsonl` (API timings,
transcript indexing, live stream stalls, send queue state).

## Making installs smaller

A first install currently downloads about **2 GB**, and almost none of that is
OMG itself — it is agent-runtime binaries pulled in as transitive
`optionalDependencies`:

| Package | Size |
| --- | --- |
| `@openai/codex-linux-x64` | 336 MB |
| `@anthropic-ai/claude-agent-sdk-linux-x64` | 247 MB |
| `@anthropic-ai/claude-agent-sdk-linux-x64-musl` | 242 MB |
| `opencode-linux-x64-baseline` | 150 MB |
| `opencode-linux-x64-musl` | 147 MB |
| `opencode-linux-x64-baseline-musl` | 147 MB |

**556 MB of that cannot execute on a glibc machine at all** — they are `musl`
builds. `opencode-ai` alone declares twelve platform variants, and while Bun
filters `optionalDependencies` by `os` and `cpu`, it does not filter by `libc`,
so the wrong-libc builds land on every Linux install. There is no
`bun install --libc` flag to opt out.

Dependency resolution itself is not the bottleneck — a cold
`bun install --production` completes in about 3 seconds. The fix is to stop
shipping bytes the target platform can never run, by publishing pruned
per-platform release bundles rather than resolving the graph on each machine.
Tracking issue welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md).

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
in front of OMG, prefer Tailscale for remote access, and scope provider keys to
that environment only.

## Embedding OMG in your own product

Every release publishes `@omg-dev/protocol`, `@omg-dev/client`, `@omg-dev/react`,
and `@omg-dev/app` to npm — the last being the exact full application the
standalone web UI runs. React hosts mount it with their own transport and asset
origin:

```bash
npm install @omg-dev/app @omg-dev/client
```

See **[docs/embedding.md](./docs/embedding.md)**.

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

> **Upgrading from `lfg`?** The project was renamed in August 2026 and now lives
> at [`github.com/BennyKok/omg.dev`](https://github.com/BennyKok/omg.dev).
> GitHub redirects the old URLs. The command is `omg`; the old `lfg` command,
> `LFG_*` environment variables, and an existing `~/lfg` install directory all
> keep working, and setup never migrates a running install out from under
> itself.

## License

[MIT](./LICENSE)
