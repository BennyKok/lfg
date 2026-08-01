# Security

lfg is powerful on purpose, and that means it has a real blast radius. Please
understand it before you run it anywhere shared.

## What lfg can do

- **Spawns AI coding agents with shell access.** Sessions run `claude` / `codex` / `agent`
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

## Dependency auditing

`bun.lock` is the only lockfile that describes what we ship — the Dockerfile
copies it, CI runs `bun install --frozen-lockfile`, and the service runs under
bun. **GitHub Dependabot cannot parse `bun.lock`**; it only understands
`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`. Stale npm lockfiles used
to sit in the repo, so Dependabot spent its time on a dependency graph nobody
installed while missing the real one. Those files are gone — do not reintroduce
one to appease a scanner.

Use `bun audit` instead. The `audit` workflow runs it on every push and PR plus
weekly (so advisories published against an unchanged graph still surface), and
fails on new high/critical findings.

Two things to know before changing dependencies:

- **`overrides` in `package.json` exist for security patching.** Most advisories
  here land on transitive packages, so the fix is to pin the patched version
  rather than add a direct dependency. Keep every override inside the range its
  consumers already accept — a same-major bump. Do not run `bun update <pkg>` on
  a transitive package: it promotes it to a direct dependency at the newest
  major, which can hand a consumer a version it never agreed to.
- **Accepted exceptions live in the workflow, not in someone's memory.** If an
  advisory has no fixed release, add a `--ignore=<GHSA-id>` with a comment
  covering why the exposure is acceptable and what removes it. The workflow
  always prints the unfiltered report to the job summary so an exception cannot
  silently become permanent.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (or email the
maintainer) rather than filing a public issue. We'll respond as quickly as we can.
