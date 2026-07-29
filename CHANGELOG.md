# Changelog

Recent product updates and deployment notes.

## [Unreleased]

## July 29, 2026 - Safer self-hosting and Claude skills (v0.1.118)

- Containerized LFG clients now dial wildcard-bound local servers through the
  correct loopback address, including IPv6-safe URL handling.
- Release self-updates now work with the BSD tar shipped by macOS, and injected
  platform checks correctly recognize the OMG supervisor restart path.
- Skills installed by Claude Code plugins now appear in the skills catalog with
  stable plugin-qualified names.
- Cloud deployment docs now make clear that the shared Dockerfile builds the
  checked-out source directly and does not require a release bundle first.

## July 29, 2026 - Deterministic rename settling (v0.1.117)

- Session renames now remain stable through delayed live-status snapshots,
  even when slow browser networks deliver updates out of order.

## July 29, 2026 - Instant session renaming (v0.1.116)

- Mobile session names now edit directly in the card or session header instead
  of opening a separate drawer.
- Renames appear immediately and stay stable while slow requests, background
  polls, and live status updates finish, without flashing the previous name.

## July 29, 2026 - Balanced mobile fade heights (v0.1.115)

- The mobile composer fade now matches the compact 20px header fade, removing
  the oversized dark wash above the message field.

## July 29, 2026 - Hosted galleries (v0.1.114)

- Hosted LFG surfaces now keep Shipped and Artifacts navigation available on
  mobile and restore shipped shortcuts on desktop.

## July 29, 2026 - Scroll-aware mobile header fade (v0.1.113)

- The mobile header wash now stays transparent at the top of the page so section
  labels remain crisp, then eases in across the first 24px of scrolling.

## July 29, 2026 - Shorter mobile edge fades (v0.1.112)

- Mobile Live content now stays clearer near the floating header and composer,
  with a 20px top wash and the restored 64px bottom fade.

## July 29, 2026 - Balanced mobile chat edges (v0.1.111)

- Mobile Live pages keep their side gutter for card corners and shadows while
  removing the oversized blank bands above the list and behind the composer
  fade.

## July 29, 2026 - Installable release bundles (v0.1.110)

- Hosted Computer template builds can install LFG release bundles again; the
  bundle now carries a runtime-only manifest and matching production lockfile
  instead of referencing source workspaces that are intentionally not shipped.

## July 29, 2026 - Full-width mobile chat (v0.1.109)

- The mobile Live chat page now uses the full available width without an extra
  outer gutter, while gallery-style pages keep their existing spacing.

## July 29, 2026 - Authenticated embedded artifacts (v0.1.108)

- HTML dashboards and videos in hosted Computer sessions now load through the
  authenticated session transport, so transcript cards, the Artifacts gallery,
  Shipped posts, and full-screen viewing render the artifact instead of the
  surrounding Vibes app.

## July 29, 2026 - Embedded artifact images (v0.1.107)

- Artifact images in hosted Computer sessions now load through the authenticated
  session transport, so live transcripts, Shipped posts, zoom, and full-screen
  viewing no longer show broken image placeholders.

## July 29, 2026 - Shipped review in Live (v0.1.106)

- Finished sessions now open inside the normal Live workspace on desktop and in
  the standard session sheet on mobile, while remaining read-only until the
  first message resumes them.

## July 29, 2026 - Review-first shipped sessions (v0.1.105)

- Opening a finished session from Recently Shipped now shows its transcript
  without resuming it; sending a new message resumes the session automatically
  and delivers that message as the first follow-up.

## July 29, 2026 - Unified project picker (v0.1.104)

- The desktop project control now uses the same polished folder pill and icon
  everywhere, while opening the richer project picker with all-projects,
  browse, and new-folder actions.

## July 29, 2026 - Stable session selection and deploy checks (v0.1.103)

- Choosing a different live session after opening a recent Shipped item now
  stays put instead of jumping back during background session refreshes.
- LFG now verifies both the built web assets and the exact entry bundle served
  after restart before reporting a local deployment as successful.

## July 29, 2026 - Project-scoped shipped sessions (v0.1.102)

- Recent Shipped items from project-scoped sessions now open through the normal
  transcript route instead of being misread as folder identifiers.

## July 29, 2026 - Reliable mobile layout and session completion (v0.1.101)

- Mobile lists now reserve the full header, banner, and hosted navigation space,
  keep cards clear of the floating composer, and restore consistent horizontal
  padding so content is no longer clipped or overlapped.
- Agents now explicitly decide whether a Shipped result should close its source
  session, so quick chats and likely follow-ups can stay live.
- Shipped results no longer imply production deployment, and sessions stay open
  when a requested deployment has not been verified.

## July 29, 2026 - Recent shipped sessions (v0.1.100)

- The desktop sidebar now shows the five most recently shipped sessions for
  quick access without leaving the active workspace.
- Repeated ship-post updates collapse to one entry per session, and selecting
  an item opens that exact shipped transcript ready for review or follow-up.

## July 29, 2026 - Safe concurrent delivery (v0.1.99)

- Every LFG coding session now works in its own isolated checkout, including
  sessions changing LFG itself, so concurrent agents cannot overwrite one
  another in the live deployment tree.
- Session changes land on current main through a repository-wide lock, then
  rebuild and restart the local service at that exact revision.
- Shipped completion now stays open and reports what remains whenever work is
  uncommitted, missing from main, or not yet deployed locally.

## July 29, 2026 - omg.dev hosted branding (v0.1.98)

- Hosted Computer sessions now replace the LFG mark with the coral omg mark
  and omg.dev wordmark on desktop, while mobile keeps a compact mark-only
  header.
- The hosted desktop project selector now uses the same neutral outlined folder
  treatment as the mobile composer without changing standalone LFG branding.

## July 29, 2026 - Shipped follow-ups (v0.1.97)

- Finished work in the Shipped feed now has a **Follow up** action that starts
  a separate session with the original transcript as context, preserving the
  completed source session while carrying the work forward.
- The follow-up composer supports agent, model, reasoning, prompt, and file
  choices, then opens the newly created session directly in Live.

## July 29, 2026 - Hosted attachment uploads (v0.1.96)

- File attachments now use the host application's authenticated LFG transport,
  so uploads from embedded Computer sessions reach the connected runtime
  instead of failing against the dashboard origin.

## July 29, 2026 - Edge-to-edge mobile scrolling (v0.1.95)

- Every mobile page now scrolls edge-to-edge behind the floating navigation,
  with a soft blur and fade instead of a hard content boundary.
- Live, Shipped, and Artifacts also scroll behind the persistent composer while
  matching top and bottom padding keeps every item fully reachable.

## July 29, 2026 - Single app dependency (v0.1.94)

- `@lfg-dev/app` now exports its signed transport factory and public transport
  types, so React hosts install one application package instead of declaring
  the app's nested client dependency a second time.

## July 29, 2026 - Full application package (v0.1.93)

- LFG now publishes its exact standalone application as `@lfg-dev/app`, so
  React hosts render the same desktop rail, mobile cards, session sheets, and
  composers without an iframe or a second visual implementation.
- The full application accepts one host-owned signed transport for every HTTP
  request and live WebSocket, keeps its navigation in memory, and scopes its
  stylesheet to the mounted host surface.
- Release packaging now produces the application tarball once and includes it
  alongside the protocol, client, and smaller React surface packages.

## July 29, 2026 - Finished sessions (v0.1.92)

- Successful agent work now posts its final result, leaves the live fleet
  automatically, and remains available to resume whenever follow-up is needed.
- Finished conversations now use the same transcript rendering as live
  sessions, with full history and a one-tap Resume action.

## July 29, 2026 - Native session rail polish (v0.1.91)

- The native Computer session rail now swipes cleanly on mobile with subtle
  item snapping and no exposed browser scrollbar.

## July 29, 2026 - Clean workspace builds (v0.1.90)

- Release runners now compile the shared workspace packages before the
  standalone frontend, so a clean checkout builds without cached output.

## July 29, 2026 - Deterministic package releases (v0.1.89)

- Version tags now have one release publisher, preventing local and hosted
  release jobs from racing to write the same assets.
- Package archives are cleaned before each build, so a release can contain
  only the protocol, client, and React packages for its own version.

## July 29, 2026 - Native Computer surfaces (v0.1.88)

- LFG now ships versioned protocol, client, and React packages so trusted
  hosts can render sessions directly without booting the full app in an iframe.
- The embeddable client owns one shared live connection with batched
  subscriptions and reconnect resume, while the standalone LFG app uses the
  same request transport.
- A stable Computer shell and matching session, transcript, status, and
  composer surfaces are available immediately while runtime data loads.

## July 29, 2026 - Session rail polish (v0.1.87)

- The desktop session list now fades softly at the top and bottom of its scroll
  view, making overflow feel intentional while keeping every row interactive.

## July 29, 2026 - Connected Claude SDK sessions (v0.1.86)

- The default embedded Claude session now uses the connected Claude Code
  account, instead of allowing omg's built-in proxy variables to override it.
- Computers without a connected Claude account continue using the existing
  platform runtime unchanged.

## July 29, 2026 - Prompt Stash recovery (v0.1.85)

- Typed and dictated prompts are now saved automatically in a browser-local
  Stash, so refreshing, navigating away, or a failed send no longer loses the
  text.
- Resume now combines Stash history and resumable sessions in a compact desktop
  dialog and a discoverable mobile drawer.

## July 29, 2026 - Connected Claude sessions (v0.1.84)

- Hosted Computers now launch Claude Code with the user's connected Claude
  account instead of letting omg's built-in Anthropic proxy override it, so a
  successful sign-in can immediately start real sessions.
- Computers without a connected Claude account keep using the existing
  platform runtime unchanged.

## July 29, 2026 - Personal agent connections (v0.1.83)

- Hosted Computers now distinguish omg's built-in runtime access from a
  user's own Claude Code or Codex account, so every new user sees the connect
  step until they personally sign in.
- A completed Claude Code sign-in is recognized on the next status check,
  letting the Computer open immediately without waiting for a credential cache.

## July 28, 2026 - Embedded Computer agent connection (v0.1.82)

- A fresh hosted Computer now offers Claude Code and Codex sign-in directly
  inside LFG, using the existing provider login dialogs and without requiring
  iMessage or showing a provisioning progress bar.
- Starting the first session sends one origin-checked event to the omg host so
  the $49 keep-your-Computer offer appears only after the Computer is useful.

## July 28, 2026 - Hosted animations resume reliably (v0.1.81)

- Hosted Computer activity animations now resume after returning from another
  tab or window, without reloading or interrupting the live coding session.

## July 28, 2026 - Merged branch badges (v0.1.80)

- Session change badges now switch from the neutral Review treatment to a
  green check and Merged label once the branch is merged.
- New edits or commits made after a merge return the badge to Review, keeping
  the displayed branch state accurate.

## July 28, 2026 - Transcript indexing no longer stalls serve (v0.1.79)

- Indexing a transcript message used to scan the entire search mirror, so a
  busy install would pin a CPU core and stop accepting connections — pages hung
  and the Computer looked disconnected while both services reported healthy.
  Indexing is now a constant-time lookup.
- Upgrading rebuilds the search mirror once on first start, about 8 seconds per
  200k indexed messages. Nothing is re-read from disk and no history is lost.

## July 28, 2026 - Hosted desktop project switcher restored (v0.1.78)

- Hosted desktop workspaces once again show the folder/project selector in the
  session rail, while account and settings controls remain owned by the host.

## July 28, 2026 - Durable sessions across every resume path (v0.1.77)

- Claude, Codex, OpenCode, and Pi retain their full indexed conversation when
  resumed, and Grok and Cursor sessions can now be resumed from their native
  histories in the same picker.
- The live managed-session roster now stays in memory for fast reads while
  persisting every mutation atomically, so a serve crash or restart rehydrates
  the intact session list instead of losing or briefly emptying it.

## July 28, 2026 - Codex resume history restored (v0.1.76)

- Resuming a file-backed Codex session now imports its conversation before the
  new agent starts, preventing successful resumes from opening as an empty chat.

## July 28, 2026 - Desktop embed drops bottom host pad (v0.1.75)

- When framed in omg at desktop width (lg+), host bottom inset cancels so the
  composer no longer sits above a ghost empty band. Mobile embed still clears
  the bottom Computer/Settings pill.

## July 28, 2026 - Local Computer conversation manager (v0.1.74)

- Connected Computers can now run lightweight conversation reasoning locally
  through a versioned manager protocol while the calling service retains
  privileged tool execution.
- Retried manager rounds are deduplicated durably, preventing duplicate local
  model requests during relay reconnects or Computer wake-up.

## July 28, 2026 - Reliable hosted session focus (v0.1.73)

- Hosted Computer links read their target session directly from the browser
  address during startup, so a slow router bootstrap cannot leave an older
  session open inside an otherwise-correct iframe URL.

## July 28, 2026 - Stable hosted session deep links (v0.1.72)

- Hosted Computer sessions keep their session and embed address while focus is
  resolved, preventing a redundant navigation from returning the iframe to the
  generic LFG home or identity picker.

## July 28, 2026 - Standalone device pad, cancel when embedded (v0.1.71)

- Standalone LFG restores the original home-indicator padding under Start.
- When framed in omg, that device pad cancels out so only the host-pill inset
  remains — no double gap, no flush-to-edge composer.

## July 28, 2026 - Tighten embed bottom pad on PWA (v0.1.70)

- When framed in omg, bottom safe padding is host-pill only (no stacked device
  home-indicator), and the home Start row no longer double-counts that band —
  so the large empty gap under the composer on the iOS PWA is gone while the
  session Message bar still clears the Computer/Settings pill.

## July 28, 2026 - Global safe bottom for embed (v0.1.69)

- Session chat and every other bottom surface now pad with a global
  `--lfg-safe-bottom` token (device home-indicator + omg Computer host pill), so
  the Message composer no longer sits under the floating Computer/Settings
  controls when framed in omg.

## July 28, 2026 - Reliable live-stream returns (v0.1.68)

- Returning to LFG after switching tabs or desktops now detects and replaces a
  half-dead live connection automatically, restoring transcript updates without
  requiring a page refresh.

## July 28, 2026 - OpenCode permission recovery (v0.1.67)

- OpenCode sessions no longer remain stuck on Working when a tool needs
  permission: attached LFG uploads are approved once automatically, while other
  requests surface Allow once, Always allow, and Deny choices and time out
  safely when unattended.

## July 27, 2026 - Embed host bottom inset (v0.1.66)

- When framed inside omg Computer, content lifts with a tight internal bottom
  inset so the compact host nav no longer covers the composer, while LFG's
  background still paints full-bleed under the pill (no color mismatch).

## July 27, 2026 - Embed mode for omg Computer (v0.1.65)

- When framed inside omg (or with `?embed=1`), LFG hides its own header,
  settings, user picker, and onboarding so the host product owns that chrome.
- Embedded mode defaults to all sessions and does not overwrite standalone
  filter preferences.
- Session deep-links (`?session=`) prioritize Live from first paint so the
  target session focuses faster.

## July 27, 2026 - Dismissible agent questions (v0.1.64)

- Agent questions can now be dismissed without sending a reply, including when
  another action resolves the question at the same time.
- The mobile question screen now opens directly on the question card without
  the redundant page header.

## July 26, 2026 - Codex models in the OpenCode picker (v0.1.63)

- When OpenCode is signed in with a ChatGPT Plus/Pro account, the model picker
  now offers the latest Codex models (gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
  gpt-5.5, and friends) for OpenCode sessions and auto agents, and newly
  released gpt models appear automatically after the daily catalog refresh.

## July 26, 2026 - Clean OpenCode streaming (v0.1.62)

- OpenCode sessions no longer echo the initial user prompt as temporary
  assistant output while a response is streaming.

## July 26, 2026 - Warm feeds and native groundwork (v0.1.61)

- Shipped, Artifacts, and the session list no longer cold-reload on every tab
  switch. List data is cached client-side (stale-while-revalidate, same idea as
  transcripts), those pages stay warm in the background after the first visit so
  gallery iframes don't reboot, and the feeds are prefetched during idle so the
  first open can paint from cache too.
- Auto findings can now be copied as a structured reference for use in an
  existing session, with that handoff recorded alongside reply, execute, and
  dismiss actions.
- Recurring auto findings are escalated instead of being silently treated as
  duplicates.
- Usage Campfire agents now fly naturally onto their arc and handle touch
  selection without accidental overlay dismissal.
- A documented Expo SDK 57 mobile prototype now establishes the native
  toolchain, navigation, persistence, glass experiments, and TestFlight path.

## July 26, 2026 - Reproducible motion release (v0.1.60)

- Release installs now include the complete Number Flow dependency lock data,
  so the organic activity and motion update builds reliably from a clean
  checkout.

## July 26, 2026 - Organic activity and smoother motion (v0.1.59)

- Pending user messages and live agent tool calls now share a layered organic
  colour wash, halo and crisp edge instead of a mechanical gradient sweep.
  When activity finishes, the effect fades away smoothly rather than vanishing.
- Newly sent messages now spring from the composer's actual on-screen position,
  staying spatially correct with the soft keyboard, attachments, multiline
  prompts and multi-column sessions.
- Dialogs, dropdowns, context menus and alerts now use one consistent motion
  scale, with reduced-motion fallbacks throughout.
- Live reasoning labels remain readable while their highlight moves, rather
  than fading toward invisible at the ends of the shimmer.
- The Usage Campfire's "next restore" now counts down to the second, with each
  unit rolling on its own instead of the whole line swapping once a second.
- Agent marks in the campfire are larger again.
- On touch, tapping an agent now highlights it and retargets the readout; a
  second tap on the same agent starts the session. Previously a single tap fired
  straight into the composer, before you could read anything.

## July 25, 2026 - Start a session from the campfire (v0.1.58)

- Clicking an agent in the Usage Campfire now picks that agent in the composer
  and opens it, so the campfire is a launcher as well as a readout. It resolves
  to whichever variant of that agent this box actually has configured.
- The agent logo leads each node at roughly double its old size, with the usage
  meter shrunk to a compact ring beside its own percentage underneath.
- Agent marks now cast a shape-tracing glow rather than a rectangular shadow,
  which was drawing a box behind the transparent logos.

## July 25, 2026 - Clean session pins (v0.1.57)

- Deleted sessions are now removed from browser-local pinned state instead of
  lingering in the frontend and resurfacing as stale UI.
- Closing a pinned session also dismisses its open mobile detail sheet, while
  pins in other project or owner filters remain intact.

## July 25, 2026 - Campfire, cleaned up (v0.1.56)

- The Usage Campfire now only shows agents that actually report usage —
  unconfigured providers no longer sit on the arc as greyed-out placeholders
  that read as broken.
- Hovering (or tapping) an agent retargets the centre readout to that agent's
  own next restore. If an agent doesn't report a reset time, the centre shows
  how much of its window is spent instead, so a hover always answers something.
- Loading is a real state now: ember arcs spin in place on the arc while limits
  are read, instead of an ellipsis and a static dash.
- Dropped the glass cards. Each agent is just its meter, name and percentage on
  the ember background, and the hovered one lifts while the rest recede.
- Ring colour now tracks each window's own utilization on a shared scale, so a
  ring means the same thing as the number beneath it. The previous colours were
  assigned by position and encoded nothing.
- The green/amber/red utilization scale was re-picked for colour-vision
  deficiency — the old green and amber were nearly indistinguishable to deutan
  viewers (ΔE 6.6, well under the safe floor).
- Fixed: on narrow phones the outermost agents were clipped off both edges. The
  arc is now sized from the space actually available.

## July 25, 2026 - Instant transcripts and a calmer workspace (v0.1.55)

- Opening a session is now instant. The transcript pane used to clear itself
  and refetch every time you opened a session — even one you had open seconds
  earlier — so it always waited on a full network round trip. Transcripts are
  now cached and repainted immediately, and the sessions you are most likely to
  open next are warmed in the background. On a slow connection this took
  session opens from roughly 1.7s to under 0.3s.
- The Shipped and Artifacts galleries load much faster. The artifact index is
  cached instead of rebuilt per request, and gallery tiles no longer boot a
  live iframe apiece just to render a thumbnail.
- The composer is now one shared component everywhere it appears, so the
  session view, the new-session bar, and mobile all behave identically —
  along with a single consistent status dot.
- The chat input grows with what you type, the focused stage column is easier
  to pick out at a glance, and the desktop rail has a right-click context menu.
  Long session subtitles in the rail are clamped to two lines.
- New keyboard shortcuts for opening Settings and toggling the sidebar.
- Idle sessions can be cleared in bulk directly from the sessions list.
- Agent-facing MCP payloads are slimmer and use short session ids, so agents
  spend less of their context on session bookkeeping.
- Fixed: the OpenCode backend now streams real tool arguments and results
  instead of placeholders, and no longer collides on port 4096.
- Usage Campfire: press bare **Shift** to toggle a full-screen arc of every
  agent's rate limits around a live "next restore" countdown (press Shift again,
  Esc, or click outside to close). On mobile, long-press the composer activity
  rings.
- `lfg agents auto` can now create and manage auto agents over their full
  lifecycle from the CLI.
- Fixed: the image annotator now renders above the composer dialog instead of
  behind it.

## July 25, 2026 - Quieter mobile starts and reliable ask replies (v0.1.54)

- The empty mobile live view is now a quiet, unboxed status marker instead of
  a large card that duplicated the persistent new-session composer. The
  redundant button, obsolete v2 instructions, and visible versioned startup
  copy are gone.
- Ask prompts now expire cleanly when their session is no longer waiting, and
  pivoting to a different task no longer gets mistaken for answering the old
  question.

## July 24, 2026 - Opus 5 voice advisor and a two-verb agent channel (v0.1.53)

- The voice advisor now runs on Claude Opus 5, falling back to Sonnet 5, and
  is fixed for how those models think. It used to share the voice brain's small
  reply budget; because the new models reason before answering and that
  reasoning draws on the same budget, hard questions would have come back
  truncated or silent. The advisor now has its own, much larger budget while
  the brain keeps its fast one. Consults that act on the fleet mid-answer also
  no longer fail partway through.
- Agents talk to you through two verbs instead of a scattered set of tools:
  one for telling you things (running narration in the thread, evidence and
  reports inside the session, finished work on the Shipped feed) and one for
  asking (a question for you, or a consult with the advisor). Agents are now
  expected to narrate as they work rather than going quiet for long stretches,
  and to make the reasonable call themselves instead of stopping to check in.
  Existing tools keep working.
- Ended and historical sessions are searchable again — find past sessions by
  id, owner, project, text, or when they were last active.

## July 24, 2026 - Real page URLs and relayed live views (v0.1.52)

- Every page now has its own URL. The dashboard uses real paths
  (`/settings`, `/usage`, `/coding-agents`, and so on), so the browser
  back/forward buttons work across pages, any page is directly shareable, and
  a page survives a hard refresh.
- Session deep links (`/?session=<id>`) now reliably open the linked session —
  including on mobile, on a first-run browser still behind the profile picker,
  and when the session belongs to another profile — and say so clearly when the
  session has already ended instead of silently doing nothing.
- The live session view — streaming transcript and live status — now works for
  sessions opened through a connected relay, not just the local dashboard, by
  tunneling the session's live WebSocket and SSE streams over the relay's
  existing outbound socket.
- Auto-agent findings and ask-user questions now reach relay-connected surfaces.
- Newly created session cards show a "started" badge so fresh sessions are easy
  to spot in the live view.
- Fixed a chat issue that could spin the transcript in a scroll/update loop.

## July 23, 2026 - Origin channel delivery (v0.1.51)

- Agents can now intentionally send text, screenshots, and videos back to the
  channel that launched their session through the channel-neutral
  `lfg_send_to_origin` MCP tool.
- Deliveries stay bound to their owning session, while phone numbers and
  transport credentials remain exclusively with the channel adapter.

## July 23, 2026 - Reliable mobile bundle (v0.1.50)

- Restored the mobile bottom-edge gesture guard to the published source so
  the web UI builds cleanly while protecting iOS Home and app-switching
  gestures.

## July 23, 2026 - Connected session links (v0.1.49)

- Connected computers can now advertise their public URL with
  `lfg connect --url`, or through `LFG_PUBLIC_URL`, so relays can preserve
  exact links back to individual sessions.
- Session deep links and shipped-result media now flow through connected
  relays, making remote completion messages more useful outside the LFG
  dashboard.

## July 22, 2026 - Faster, clearer session workflows (v0.1.48)

- Attachments now start uploading as soon as they are selected, and large files
  transfer in resilient 8 MB chunks so sending a message rarely waits on file
  bytes and oversized requests are less fragile.
- Desktop session actions are clearer and more dependable: Fork dialogs stay
  bright above their backdrop, sent messages remain right-aligned, and session
  references can be copied directly from the action menu.
- Settings now reports host disk usage alongside CPU and memory, including a
  capacity bar that calls out elevated utilization.
- Voice handoffs use natural conversational holds without exposing internal
  advisor, model, or session terminology.
- Optional `lfg connect` lifecycle notifications now ignore subagents and
  short-lived top-level sessions, keeping remote completion alerts focused on
  meaningful work.

## July 20, 2026 - Visible mobile selection (v0.1.47)

- Selecting text from a sent-message bubble now keeps the native highlight and
  selection handles above the glass card instead of clipping them underneath it.

## July 20, 2026 - Faster message sharing (v0.1.46)

- Every user and assistant message now has a one-tap copy action. On mobile,
  long-pressing message text opens quick Copy and Select text actions, so people
  can either grab the whole response immediately or use native selection handles.
- `lfg connect` can now optionally forward session completed/needs-attention
  events to the relay it's paired with (`LFG_CONNECT_EVENTS=1`, off by
  default — session titles leave the box when enabled). See the "Session
  lifecycle events" section in the README's `lfg connect` docs.

## July 20, 2026 - Smart session cleanup (v0.1.45)

- Smart clear and other LFG-managed agents can now close sessions through the
  supported MCP surface after resolving an exact session id.
- Session closing refuses self-termination, and capability guidance now reports
  a refresh only for genuinely stale sessions instead of masking missing tools.

## July 20, 2026 - Responsive chat and resilient indexing (v0.1.44)

- Session and bootstrap requests no longer fan out eager transcript-page reads
  across the fleet, eliminating the load amplification that stalled chat,
  artifacts, voice, and the connection ping together.
- Message delivery now resolves sessions through the shared live cache, avoiding
  a full process and tmux discovery pass on every send.
- Artifact refreshes fail fast and retry their SQLite mirror when another writer
  is active; scheduled refreshes can no longer crash or freeze the LFG server,
  and durable manifests reconcile automatically after restart.
- Transcript write transactions acquire the SQLite writer lock up front, trace
  pages are sampled with seven-day retention, and database planner/search
  metadata is repaired and optimized during rollout.

## July 19, 2026 - Consistent live media and connection health (v0.1.43)

- Settings now shows the real browser-to-server WebSocket ping, refreshed every
  five seconds with clear live, reconnecting, and offline states.
- Transcript media now has one explicit, atomic placement and ordering path.
  Gallery and Shipped assets can no longer leak into chat, empty cards are
  suppressed, stable artifact ownership remains singular, and legacy orphaned
  or misclassified placements are repaired during migration.
- Transcript reads no longer scan and rewrite artifact metadata or run one JSON
  poller per open pane, restoring millisecond artifact delivery and responsive
  local API requests on large indexes.
- `lfg connect` — a new generic remote-access relay client. Lets a
  self-hosted box be reached through an operator-run relay without opening
  any inbound port: the box dials out over a WebSocket, authenticates with a
  one-time pairing code (then a persisted bearer token), and proxies HTTP
  traffic onto its own local `lfg serve`. No relay implementation ships with
  LFG — `LFG_RELAY_URL` is a required, provider-agnostic setting (see the
  README's "lfg connect" section and the wire protocol documented in
  `src/commands/connect.ts`).

## July 18, 2026 - Transferable live dashboards (v0.1.42)

- Re-publishing a stable HTML artifact id from a later session now updates the
  same dashboard, transfers ownership and refresh control, and continues its
  existing revision history.

## July 18, 2026 - Correct Pi and Copilot icons (v0.1.41)

- Pi now uses its official block logo instead of a generic pi glyph, with a
  fresh cache version so the corrected artwork appears immediately.
- Pi and GitHub Copilot icons are now served by the production static-asset
  route, fixing missing icons outside the development server.

## July 18, 2026 - Custom agent profiles (v0.1.40)

- Agents can now load a custom profile from a directory (`LFG_PI_PROFILE_DIR`):
  extra system-prompt text, a skills directory, and a display name — injected
  via pi's native `--append-system-prompt`/`--skill` flags. Lets operators
  brand and specialize managed pi sessions without forking LFG.

## July 18, 2026 - More agents and reliable mobile layers (v0.1.39)

- Pi and GitHub Copilot are now first-class coding-agent choices across setup,
  session creation, model selection, and managed launches.
- Agents receive the LFG presentation workflow automatically, including visual
  verification, live artifact publishing, and shipped-work showcases.
- Script-backed artifacts can be refreshed manually, and desktop trackpad
  gestures can cycle the active project without leaving the live view.
- Mobile nested surfaces now stack correctly: Fork stays above an open chat,
  and the model selector drawer fully covers its originating control pop-up.

### Added

- **GitHub Copilot CLI** (`@github/copilot`, binary `copilot`) as an 8th supported coding agent:
  - Settings → Coding agents tile with binary + auth status checks. Auth precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`, falling back to a real login artifact (`~/.copilot/hosts.yml`, `config.json`, or `session-state/`) rather than a bare `~/.copilot/` directory.
  - Tmux-transport session launcher `spawnManagedCopilotSession` wired through `serve.ts` so `agent=copilot` requests dispatch to Copilot instead of falling back to Claude. Launches interactively via Copilot's supported `-i, --interactive <prompt>` flag, which starts a long-lived TUI and auto-executes the initial prompt (no `-p` one-shot, no send-keys polling).
  - `--allow-all-tools` is opt-in through `LFG_COPILOT_ALLOW_ALL_TOOLS=1`. Off by default because LFG's agent slice is resource containment, not a filesystem/network sandbox.
  - Curated model catalog: `claude-sonnet-4.5` (default), `claude-sonnet-4`, `gpt-5`.
  - `scripts/setup.sh` installs `@github/copilot` when `LFG_INSTALL_COPILOT=1` (requires Node 22+), pinned to `LFG_COPILOT_VERSION` (default `1.0.71`) for reproducibility and to avoid GHSA-g8r9-g2v8-jv6f (`<=0.0.422`, prompt-injection RCE via shell parameter expansion) and GHSA-9ccr-r5hg-74gf (`<=1.0.42`, `core.fsmonitor` RCE via nested bare repo).
  - New `LFG_COPILOT_PATH`, `LFG_COPILOT_ALLOW_ALL_TOOLS`, and `LFG_COPILOT_VERSION` env overrides.

## July 16, 2026 - Shipped feed and live artifacts (v0.1.37)

- New Shipped channel: a feed of agent-published work, available as a virtual
  page in the project menu with kind filters (all/html/image/video), live HTML
  previews, load-more paging, tweet-style posts with real agent-kind bylines,
  and `?tab=` deep links.
- HTML artifacts are now updatable: a persisted script refresh runner (also
  exposed over MCP) re-renders them on demand, with visible refresh state,
  stable revisions across data refreshes, clean cancellation, and deletion.
- Added a native full-page artifact viewer and a dedicated all-artifacts
  gallery; tapping a post opens the session that shipped it.
- Mobile swipe polish: no more composer-bar or mid-swipe flashes when changing
  project pages, and the right nav island stays identical across swipe pages.
- Subagents launched inside a slice are now bound to their transcript via
  cgroup, fixing misattributed output; agent swarms get bounded memory and
  concurrency.

## July 15, 2026 - Durable sessions and faster image viewing (v0.1.36)

- Session worktrees now live under a persistent LFG-managed root instead of a
  temporary directory, and Claude and Codex resume flows show full history.
- Image artifacts now use cached, size-bounded WebP previews in transcripts and
  the lightbox, reducing transfer and decode costs while preserving originals.
- Image display retries no longer create duplicate transcript entries when the
  shared SQLite index is busy; durable artifacts succeed and reconcile into the
  ordered message stream, with a short idempotency window for agent retries.
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
