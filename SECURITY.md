# Security

lfg is powerful on purpose, and that means it has a real blast radius. Please
understand it before you run it anywhere shared.

## What lfg can do

- **Spawns AI coding agents with shell access.** Sessions run `claude` / `codex`
  on your box (often with permissions skipped so they don't block), so an agent
  can read, write, and execute within the repos it's launched into.
- **Exposes an unauthenticated HTTP API** on `LFG_PORT` (default `8766`). Anyone
  who can reach that port can list sessions, start new agents, send them input,
  and answer their prompts. There is **no login** — this is by design, on the
  assumption the port is reachable only over a private network.
- **Reads local files and logs.** Collectors read git history and repo files; the
  optional `security_scan` collector runs **read-only** host probes (login
  history, listening ports, cron/systemd, SSH authorized_keys, package audits).
- **Talks to services you configure** — GitHub, OpenRouter, an optional voice
  TTS/STT upstream, and optionally WhatsApp.

## How to run it safely

- **Never bind to a public interface.** Keep `LFG_HOST=127.0.0.1`. The provided
  systemd unit hard-sets this so a stale `.env` can't override it.
- **Keep repro servers loopback-only.** For throwaway static servers, use
  `python3 -m http.server --bind 127.0.0.1 <port>` and stop the process when
  done. Never leave a `/tmp` or worktree repro server listening on `0.0.0.0`.
- **Reach it over Tailscale, not the internet.** Use `tailscale serve` (HTTPS on
  your MagicDNS name, tailnet members only). Do **not** use `tailscale funnel`,
  and do not open `8766`/`443` in your cloud firewall. `scripts/setup.sh` sets
  this up for you.
- **Run as a non-root user.** The setup script refuses to run as root and installs
  a systemd *user* service. Agents should never run as root.
- **Scope your credentials.** Use a dedicated, least-privilege GitHub token and
  SSH keys; assume anything reachable by an agent on the box is reachable by lfg.
- **Treat Tailscale auth keys as secrets.** Pass `TS_AUTHKEY` on the setup command
  line only; it is never written to disk. Prefer ephemeral, pre-approved, tagged,
  single-use keys.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (or email the
maintainer) rather than filing a public issue. We'll respond as quickly as we can.
