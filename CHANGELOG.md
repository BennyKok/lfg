# Changelog

Recent product updates and deployment notes.

## July 15, 2026 - Durable sessions and faster image viewing (v0.1.36)

- Session worktrees now live under a persistent LFG-managed root instead of a
  temporary directory, and Claude and Codex resume flows show full history.
- Image artifacts now use cached, size-bounded WebP previews in transcripts and
  the lightbox, reducing transfer and decode costs while preserving originals.
- Refined session-management and resume surfaces, including modal layering,
  keyboard handling, and responsive navigation behavior.

## July 14, 2026 - Desktop polish and upload progress (v0.1.35)

- Refreshed the desktop navigation rail, header, and session stage to match the
  mobile visual language, with improved glass surfaces, spacing, and controls.
- File attachments now show real per-file upload percentages and progress bars
  in both active-session and new-session composers, including concurrent files.
- Fixed the desktop Manage Sessions menu trigger for Base UI compatibility.

## July 14, 2026 - Installable app and resilient recovery (v0.1.34)

- Added a discoverable PWA install flow on desktop and mobile, including the
  native Chromium prompt, guided Apple installation steps, standalone detection,
  and proper platform, maskable, and Apple touch icons.
- Managed SDK sessions now keep a durable resume record with their model,
  project, and assigned user, so closed or restarted sessions can be recovered
  reliably. OpenCode sessions also participate in the agent filters and model
  pickers throughout the web UI.
- Theme choices now persist across reloads, and voice provider API keys can be
  configured securely from the setup dialog.
- The Manage Sessions launcher now stays accessible in the appropriate desktop
  and mobile navigation positions, and the OMG badge points to the correct
  template page.

## July 14, 2026 - Ready-by-default live sessions (v0.1.33)

- WebSocket live transcripts are now the default for the server and web client,
  so a standard install no longer needs `LIVE_TRANSPORT=ws`. Set it explicitly
  to `sse` only for compatibility with a proxy that cannot upgrade WebSockets.

## July 14, 2026 - Sandbox-safe release updates (v0.1.32)

- Release setup and in-app updates now ignore host-injected tar defaults,
  replace the prior application bundle explicitly, and avoid restoring archive
  ownership, permissions, or timestamps that restricted sandbox filesystems can
  reject.
- Existing folders initialized as new Git repositories can now launch their
  first coding-agent session before an initial commit exists. That first session
  runs in the selected folder; normal isolated worktrees resume after HEAD is
  created.

## July 13, 2026 - Blank-project picker fixes (v0.1.31)

- Fresh installs now create their configured repository root when the project
  browser first opens, so a missing `~/repos` no longer blocks listing or
  creating a project.
- The live composer project control now displays the selected project name, and
  newly browsed or created folders become the active composer project
  immediately.

## July 13, 2026 - Live install logs during onboarding (v0.1.30)

- Onboarding now streams the real installer output in a single live log while a
  batch install runs, instead of painting the same synthetic progress bar on
  every selected agent. Each agent row shows a simple **Installing…** state and
  the shared log tells you exactly what setup is doing.
- Backend captures stdout and stderr from the shared `setup.sh` run and exposes
  it at `GET /api/coding-agents/setup/log`.

## July 13, 2026 - Reliable OMG onboarding installs (v0.1.29)

- Fixed the onboarding batch endpoint being shadowed by the generic per-agent
  route, which caused a correct multi-agent request to fail with
  **unknown coding agent**.
- OMG template installs now record their release channel and repository, so
  Settings can check releases and enable supervisor-aware updates.

## July 13, 2026 - Repeatable setup on OMG (v0.1.28)

- OMG agent-template installs now recognize their existing guest supervisor, so
  **Update & restart** can safely install a release and relaunch LFG.
- Onboarding displays the exact LFG version being configured.
- Settings now includes **Redo onboarding**, which reopens the full walkthrough
  without deleting existing profiles, repositories, or sessions.

## July 13, 2026 - Batch agent installation (v0.1.27)

- Onboarding now lets users choose coding agents with individual checkboxes or
  Select all, then installs the complete selection in one setup run.
- Selected agents share installation progress while already configured agents
  are left untouched.

## July 13, 2026 - Ready-to-run local projects (v0.1.26)

- New projects now initialize a `main` branch and commit their starter README
  before appearing in the project picker, so the first session can always
  create its isolated Git worktree.
- Local projects without an `origin/main` remote now correctly use their local
  `main` commit as the worktree base.
- Failed project setup rolls back the new folder instead of leaving a partial
  project behind.

## July 13, 2026 - UI sound & haptics, composer polish (v0.1.25)

- Added UI sound effects and haptic feedback across the app: a light press
  tick on buttons, distinct on/off tones on toggles, a send whoosh, tab-switch
  and agent-swipe cues, and success/error chimes on toasts. Sounds are
  synthesized (no assets) and both are toggleable in Settings → Feedback
  (default on); `haptic()` now respects the haptics setting everywhere.
- Reworked the inline composer's controls into two animated mini-cards (agents,
  then model/thinking/project) emitted from the agent icon.
- Polished the session assign menu with avatar chips matching the user filter.
- Kept the terminal surface dark regardless of theme.
- Extended the source updater to support release installs alongside Git installs.

## July 13, 2026 - Source auto-update (v0.1.24)

- Added an update panel in Settings for Git/source installs that checks
  `origin/main`, reports available commits, and can update with one click.
- Source updates require a clean `main` checkout, fast-forward safely, install
  locked dependencies, rebuild the web UI, and restart the managed systemd or
  launchd service before reconnecting the browser.
- Added coverage for up-to-date, behind, dirty, and non-main checkout states.
- Refreshed the web lockfile so frozen CI installs include the AI SDK packages
  already declared by the web app.

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
