# Changelog

Recent product updates and deployment notes.

## July 5, 2026 - Setup checks & steadier resumes

LFG now exposes setup checks for local MCP registration and keeps resumed
sessions tied to the project they came from.

- Added an LFG MCP setup check in Settings -> Coding agents, including one-click
  registration for Claude and Codex when those CLIs are available.
- Registers the LFG MCP server during setup by default for local Claude/Codex
  installs.
- Preserves project labels across resumed and managed sessions, even when the
  underlying agent reports a stale cwd.
- Makes resumed Claude sessions stay open for follow-up instructions when no
  prompt is provided.
- Tightened recent-session close guards and fixed several mobile UI edge cases.

## July 2, 2026 - Configurable session brain & refreshed UI edges

The session brain can now run on the model you choose, and the interface picks up a consistent gradient-glass edge across buttons, inputs, and surfaces.

- Added a per-config model for the session brain (classify/summarize), seeded from env and adjustable from the Session Brain view; defaults to Sonnet 5.
- Introduced reusable gradient-border and gradient-edged form-field treatments, applied across buttons, inputs, and surfaces.
- Gave the notepad its own bounded scroll area with a scroll-aware edge fade.
- Let session resume carry a prompt and an agent-aware model.
- Fixed live streaming for AI SDK sessions and versioned the service-worker shell cache.

## June 29, 2026 - Safer installs

Fresh installs now leave existing Tailscale Serve settings alone unless you explicitly opt in.

- Skips Tailscale Serve setup by default so lfg does not claim HTTPS 443 on install.
- Adds an opt-in path with `LFG_TAILSCALE_SERVE=1` for private tailnet exposure.
- Protects existing Serve routes from accidental overwrite unless `LFG_TAILSCALE_SERVE_OVERWRITE=1` is set.

## June 29, 2026 - Project-focused live view

Sessions now group cleanly by repo project, with steadier filters and fewer stale worktree entries.

- Collapsed session worktrees into project names for simpler scanning.
- Kept resumed worktrees during cleanup so active sessions do not disappear.
- Removed the extra project-selector arrow for a tighter top bar.

## June 2026 - Agent reliability

Codex and automation paths got stricter defaults and better failure handling.

- Fixed stateless Codex auto-agent runs.
- Added install-channel awareness so update guidance matches source, release, and container installs.
- Stabilized speech playback state to avoid repeated render loops.

## June 2026 - Deployment options

Container deploys and hosted setup docs are now part of the project workflow.

- Added Docker-backed targets for Railway, Fly, Render, Koyeb, DigitalOcean, and Hetzner.
- Published bundled-release flow for cloud installs.
- Documented operational scripts for voice and GPU STT deployments.
