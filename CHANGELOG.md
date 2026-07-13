# Changelog

Recent product updates and deployment notes.

## July 13, 2026 - Native project picker & clean MCP images (v0.1.23)

- Replaced the composer's native repo select with a mobile-friendly project
  sheet that lists project paths and makes browsing or creating a project a
  first-class action.
- The inline composer now opens the same project sheet from its folder button,
  keeping project selection consistent across composer layouts.
- Stopped MCP image results from emitting redundant Markdown URLs that could
  render as broken images; clients continue to receive the structured artifact.

## July 12, 2026 - Fix agent-icon swipe gesture (v0.1.22)

Follow-up to v0.1.21: the swipe-to-switch gesture didn't actually fire.

- The agent icon `<img>` is draggable by default, so a press-drag started a
  native image drag and fired `pointercancel` after the first move — killing
  the swipe before it crossed threshold. The icon is now `draggable={false}` /
  `pointer-events-none`.
- Reworked the gesture to pointer events (one path for mouse-drag, touch and
  pen) tracked on `window` so the drag survives the pointer leaving the 32px
  target, and Base UI's press-to-open is suppressed so a swipe never also opens
  the popover (tap still opens it). Verified end-to-end in a headless browser.
- Note: the inline composer that hosts this icon is the mobile home screen
  (viewport ≤ 767px); on wider/desktop layouts the agent switcher is the
  button row inside the composer controls.

## July 12, 2026 - Swipe-to-switch agent & cached agent icons (v0.1.21)

The composer's agent icon is now a quick gesture target, and agent icons stop
re-downloading on a timer.

- Swipe up/down (or trackpad-scroll) on the inline composer's agent icon to step
  through the visible agents, with a slide+fade animation; tapping still opens
  the full agent/model popover.
- Agent icons are now versioned (`?v=…`) and served `immutable` for a year, so
  they load once and never re-fetch on subsequent renders. Other static assets
  gained `ETag`/`Last-Modified` revalidation (cheap 304s) instead of a bare
  5-minute `max-age` that forced full re-downloads.
- Media artifacts are indexed into the transcript index so images obey the same
  pagination boundary as prose instead of appending to whichever page loaded.
- Added "use this folder" / "create new folder" project onboarding (with
  `git init`) in the repo store.
- Coding-agent setup reports progress, and Claude/Codex login commands use the
  device-auth / `--claudeai` flows.

## July 11, 2026 - Auto-agent picker parity (v0.1.20)

Auto agents can use the same providers as new sessions, and the settings sheets
use shorter copy.

- Auto-agent create/edit/finding sheets now offer Claude, Codex, Grok, Cursor,
  and OpenCode (filtered by coding-agent visibility), matching the session
  picker.
- Added headless runners for Grok and Cursor auto agents.
- Tightened auto-agent settings labels and placeholders.
- Kept display images in transcript order, and improved cursor-agent busy
  detection plus the Grok session model fallback.

## July 9, 2026 - Direct transcript indexing & a single chat state (v0.2.0)

Managed sessions no longer read or write transcript JSONL: all three SDK
harnesses (Claude, Codex, OpenCode) index their message streams straight into
SQLite, and the web chat pane now runs entirely on AI SDK `useChat`.

- Claude, Codex, and OpenCode managed sessions run on their official SDKs and
  index messages directly into SQLite under `lfg://session/<id>` keys — opening
  a chat is one ~2ms DB read, with no transcript files in the loop.
- Migrated the web chat pane to `@ai-sdk/react` `useChat` as the single state
  system: history is fetched per open, live updates append through the shared
  WebSocket subscription, and duplicate handling lives in exactly one place.
- Fixed live-view blindness after a serve restart: snapshot/gap/resumed frames
  are now authoritative resync points instead of being dropped by the stale-seq
  guard, so long-lived pages recover instead of going silent.
- Fixed re-entered chats rendering history-less: message state now survives for
  every subscribed session (not just busy ones), and resume cursors are dropped
  with their subscriptions.
- Fixed Codex sessions silently losing every reply after turn 1 (per-turn item
  id collisions), duplicated transcripts from rollout re-ingestion, and command
  replay storms after a harness restart.
- Fixed tmux Codex transcript discovery: rollouts are inferred by prompt, cwd,
  and time, and the mapping is persisted so transcripts still resolve after the
  pane is gone.
- Streaming drafts reset as each assistant message finalizes, so long
  multi-tool turns no longer accumulate into one duplicated blob.
- Temporarily de-listed the Hermes agent from all pickers and spawn paths to
  focus on the core harnesses (`agent=hermes` now returns a clear error).

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
