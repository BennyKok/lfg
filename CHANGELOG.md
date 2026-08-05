# Changelog

Recent product updates and deployment notes.

## August 5, 2026 - Finding sheet thinking matches the composer (v0.1.262)

- Opening a finding to launch a fix still used a plain Thinking dropdown. It
  now shares the same signal bars, level label, and hold-to-scrub control as
  the new-session composer and fork dialog — including auto-agent launch
  pickers that use the same row.

## August 5, 2026 - Found it: the black home-screen app (v0.1.261)

- A stale service worker could hold an installed app hostage forever. Tapping
  the icon fetched `/sw.js` two dozen times and never once requested the page:
  the old worker answered navigations from its own cache, so the app never
  loaded and nothing on the page could recover it.
- The replacement worker was failing to install. It did all its cache
  housekeeping *before* handing over control, so a single Cache API error (iOS
  storage pressure, an evicted bucket) aborted the install and left the old
  worker in charge. Takeover now happens first and unconditionally; cache work
  is best-effort and can never block it.
- The launch diagnostics now judge one launch at a time instead of pooling
  every device together — a healthy laptop tab was masking a failing phone.

## August 5, 2026 - A black PWA can finally say what went wrong (v0.1.260)

- New **/__lfg_pwa_diag** page reports how far a home-screen launch actually
  got, and names the layer that failed. Open it from any device — a phone stuck
  on a black screen cannot show you anything, so the answer lives on the server.
- It distinguishes the cases the last several fixes were guessing between: the
  phone never reached the box at all (network / Tailscale), the page was sent
  but never ran, the app bundle never evaluated, or the app mounted and painted
  nothing.
- The app now reports its boot phases as it starts, so "it's black" becomes a
  specific failure instead of a symptom.

## August 5, 2026 - Fresh home-screen install no longer reloads into black (v0.1.259)

- A brand-new Add to Home Screen was force-reloading on service-worker activate
  (and again on controllerchange), which left real iPhones on a solid black
  screen even after every icon was deleted. Fresh installs no longer reload;
  only upgrades that purge old shell caches do.
- Manifest start_url is plain `/` again (install id stays unique).

## August 5, 2026 - Home-screen loads like Safari (v0.1.258)

- The service worker no longer intercepts page or asset loads. That fetch
  handler is what made every iOS home-screen install solid black while Chrome
  and Safari on the same URL worked. The worker now only handles push
  notifications and wipes old caches on update.

## August 5, 2026 - Home-screen vs Safari are different (v0.1.257)

- On iPhone, resetting lfg in Safari does not reset the home-screen app — they
  keep separate website data. The reset page now detects which one you opened
  and tells you to delete the black icon before re-adding.
- A fresh Add to Home Screen uses a new install id so iOS does not revive the
  stuck profile.

## August 5, 2026 - PWA actually updates (v0.1.256)

- Home-screen LFG installs were keeping a cached service worker forever on iOS
  (`updateViaCache` default), so recovery code never arrived. Registration now
  opts out of HTTP caching for worker updates, new workers activate immediately,
  and every deploy rewrites the worker identity from the live index stamp.
- Open `/__lfg_pwa_reset` in Safari to force-clear a stuck install.
- A home-screen install that only showed solid black no longer falls back to an
  empty cached HTML document; the splash shows an "lfg" wordmark and recovery UI.

  falls back to an empty cached HTML document. The service worker only reuses
  a real app shell, otherwise it shows retry / clear-cache controls.
- The splash always paints the "lfg" wordmark (not only the icon), and if the
  app has not mounted after four seconds the recovery UI appears.

## August 4, 2026 - Black LFG PWA actually recovers (v0.1.255)

- A home-screen LFG app stuck on a black screen after a deploy now recovers
  even when the old shell never loaded the app bundle: the service worker
  registers from the page itself, clears the dead shell cache, and reloads.
- Offline launches without a usable shell show a retry / clear-cache screen
  instead of a solid black window.
- If the black splash is still up after ten seconds, the page now shows an
  explicit recovery UI (retry / reset install data) instead of hanging forever
  — including when site data was already cleared and the app still never mounts.

## August 4, 2026 - Black LFG PWA self-heals (v0.1.254)

- An installed LFG home-screen app that was stuck on a black screen after a
  deploy now clears its stale shell cache once and reloads onto the current
  build, instead of sitting on missing content-hashed chunks until you wipe
  the app by hand.

## August 4, 2026 - Settings controls stay clear (v0.1.253)

- Settings now shows a real on/off switch for pausing new agents, so the
  current state and the available action are visible without guessing that the
  whole row is clickable.
- Mobile secondary pages now leave enough room below the floating back header,
  keeping the first settings content from colliding with navigation.

## August 4, 2026 - New sessions show up when you make them (v0.1.252)

- A newly created session now appears in the list immediately instead of after
  a delay of several seconds. The create call returns the session itself, and
  a session no longer falls out of the list entirely while its agent is still
  starting up.
- The "Creating session…" indicator now stays up until the new session is
  actually on screen, rather than finishing before there is anything to see.
- An OpenCode session that fails on its first turn — a rate-limited or
  overloaded provider, a bad key — now says so in the transcript instead of
  sitting on "Working" forever with nothing in it.

## August 4, 2026 - Thinking at a glance (v0.1.251)

- Thinking controls now show their selected effort level directly beside the
  control name and signal-strength indicator, while hold-and-slide adjustments
  use relative finger movement from the currently selected level.

## August 4, 2026 - Mobile pages find their place (v0.1.250)

- Fork and Continue now share the composer's tactile Thinking control, with a
  colored signal-strength indicator, selection-safe long press, and a cleaner
  icon-free slider popup.
- On mobile, Notifications and Artifacts now open as secondary pages from the
  Pages menu, with an explicit back-to-Live action and no composer or
  swipe-through project navigation competing with their content.

## August 4, 2026 - Thinking at your fingertips (v0.1.249)

- The live-session menu now labels its thinking control simply as "Thinking",
  matching the other session-launch controls.
- The new-session composer now turns its Thinking control into a tactile effort
  slider on long press, with tap-to-pick fallback, live level previews, and
  haptic feedback while scrubbing.

## August 4, 2026 - A hosted welcome that knows you (v0.1.248)

- Embedded LFG surfaces can now receive the signed-in viewer's display identity
  from their host, so omg.dev's mobile Computer greets the person by name while
  keeping LFG session ownership and authorization completely separate.

## August 4, 2026 - Questions stay in the conversation (v0.1.247)

- Questions that need your input now appear inside the session that asked them,
  with suggested answers and a freeform reply box available right where the
  conversation is already open.
- Thinking-level menus now use the simpler visible label "Thinking" across new
  sessions, forks, and agent workflows while keeping every level selectable.

## August 4, 2026 - Image quality stays visible (v0.1.246)

- Every image attachment now shows its HD quality control immediately. Large
  images keep the compressed/original toggle, while images already being sent
  at full resolution show HD selected instead of hiding the control.

## August 4, 2026 - Recovery needs one tap (v0.1.245)

- Sessions recovered after a host restart now offer a one-tap Continue action,
  and paused sessions use a clear pause icon in place of the normal green idle
  dot without relying on emoji labels.

## August 4, 2026 - Thinking controls tuck in (v0.1.244)

- The live thinking-level selector now lives inside the existing session menu
  on desktop and mobile, keeping session headers focused while still showing
  the current level at a glance in the menu.

## August 4, 2026 - Thinking controls, in the moment (v0.1.243)

- Live session headers now show the active thinking level and let you change it
  for subsequent turns without starting over; each agent offers only the levels
  its current runtime supports.

## August 4, 2026 - Mobile controls return (v0.1.242)

- The standalone mobile Live header once again shows its top-right account and
  pages island alongside the personal welcome. Hosted omg.dev surfaces still
  leave that corner to the host's own controls.

## August 4, 2026 - The first message is yours again (v0.1.241)

- LFG's launch instructions are shorter while preserving the narration,
  verification, shipping, landing, and session-safety rules agents need.
- The runtime contract now appears as its own collapsed instructions block in
  the transcript, so the user's actual first message is immediately readable;
  existing session history benefits without being rewritten.

## August 4, 2026 - One reconnect, one message (v0.1.240)

- Embedded Computer surfaces now share the same reconnect notification from
  interruption through recovery, so returning to Home or Settings cannot show
  "Reconnected" twice for one physical connection.
- Cloud Computers now archive the minimum number of oldest idle, durable agents
  needed to admit new work safely; their transcripts remain available from
  Resume, and the new session appears immediately instead of failing on memory.
- Plan concurrency is authoritative throughout LFG: Free allows 1 active agent,
  Personal 5, Pro 16, and Always-on 24, including the Settings and Performance
  surfaces users see.

## August 3, 2026 - The welcome comes home to omg (v0.1.239)

- omg.dev's mobile Computer now shows the same personal Live welcome, active
  agent count, and agent-question handoff as standalone LFG instead of falling
  back to a static logo.
- The shared header automatically leaves room for omg.dev's account and plan
  controls, so hosted and standalone surfaces keep one behavior without
  overlapping their independently owned chrome.

## August 3, 2026 - Continued sessions keep their names (v0.1.238)

- Continuing a session into a replacement now carries over the source session's
  displayed name, including names you set yourself, instead of naming the new
  session from its internal handoff prompt. Ordinary forks still get their own
  independent name.

## August 3, 2026 - Agents stop before the Computer does (v0.1.237)

- Cloud Computers now reserve memory before starting an agent and keep enough
  headroom for LFG, the operating system, and the secure tunnel to stay alive.
- Simultaneous starts share one atomic memory budget, so a launch burst cannot
  race the machine into an out-of-memory crash. When memory is tight, LFG asks
  the user to finish an agent or upgrade instead of starting work that will die.

## August 3, 2026 - Photos upload small by default (v0.1.236)

- Images attached to any composer are now downscaled and re-encoded in the
  browser before they upload: a 1.6 MB phone photo goes up as a 96 KB WebP, so
  attachments land in a fraction of the time on a phone connection.
- Tap **HD** on an attachment chip to send the untouched original instead, and
  tap it again to go back to the compressed copy. Sending while an image is
  still compressing waits for the small copy rather than racing it.
- Annotated screenshots are compressed on the same terms, images already small
  enough are left alone, and GIFs keep their animation.
- Re-encoding also drops camera EXIF, so a photo's GPS coordinates no longer
  ride along with the upload.

## August 3, 2026 - Listing sessions gets out of everything else's way (v0.1.235)

- Binding a newly started Codex session to its transcript used to search every
  Codex session ever recorded on the box — 3,604 of them here, re-checked every
  couple of seconds. It now looks only at the last week, which is all a
  just-started session can be, and the session list rebuilds around a quarter
  faster.
- The last piece of the rebuild that stopped the server outright — asking tmux
  for its panes — no longer does. The worst pause the rebuild inflicts on
  everything else is down to about 10ms.
- Both changes were checked against the real fleet: the session list they
  produce is identical, down to every Codex binding and tmux pane.

## August 3, 2026 - The right agent from the first frame (v0.1.234)

- Managed Computers now keep the saved OpenCode choice visible while their
  live agent roster loads, instead of briefly presenting Claude during boot.

## August 3, 2026 - More room for parallel work (v0.1.233)

- Cloud Computers now admit up to 1 simultaneous agent on Free, 5 on Personal,
  16 on Pro, and 24 on Always On, with atomic reservations preventing a burst
  of launches from exceeding the plan's limit.

## August 3, 2026 - Forking stays put (v0.1.232)

- Fork and Continue now open in a stable modal on phones instead of a draggable
  drawer, so typing, textarea scrolling, and the software keyboard no longer
  compete with the sheet gesture. Compact keyboard layouts keep every action
  reachable through the modal's own scroll area.

## August 3, 2026 - Your Computer, ready first (v0.1.231)

- Managed hosts can now open a credential-free Computer directly and keep
  Claude, Codex, and other provider connections as optional Settings actions.
- Ordinary embedded LFG installs retain the existing first-run connection
  guide unless their host explicitly takes ownership of onboarding.

## August 3, 2026 - A focused first choice (v0.1.230)

- Grok is temporarily hidden from the first-run Computer connection choices.
  Its existing login and runtime support remain intact for a future return.

## August 3, 2026 - Every link opens in the right folder (v0.1.229)

- Tapping an Ask question now opens the conversation that asked it, while an
  explicit More action expands the full question and reply composer in place.
- Opening a session from Notifications or Artifacts now selects that session's
  folder automatically, so the destination is visible in the correct scope.

## August 3, 2026 - Your Computer meets your tools (v0.1.228)

- The first-run Computer connection flow now has two focused steps: connect a
  coding agent, then connect the tools that agent works through.
- Grok joins Claude Code and Codex as a browser-login option, using its existing
  device-code flow with no terminal handoff.
- GitHub can now be connected from onboarding for private repositories, pushes,
  and pull requests. The same device-login session owner handles agent and tool
  authentication, including expiry and cancellation.

## August 3, 2026 - Toasts land on the right edge (v0.1.227)

- Desktop toasts now sit at the bottom of the screen, while mobile toasts stay
  below the top chrome and fold their stacked layers back toward the top edge.

## August 3, 2026 - Computer plans guard their real capacity (v0.1.226)

- Cloud Computers now enforce their plan's agent concurrency at LFG's single
  session-admission boundary: Free/Trial 1, Personal 2, Pro 4, Always On 8.
- Concurrent launch races reserve a slot before any asynchronous work, so a
  burst of requests cannot overfill the machine while sessions are registering.
- A live plan change is read from the control-plane-owned plan file on every
  admission, so downgrades lower the cap immediately without restarting LFG.

## August 3, 2026 - A welcome that knows when to speak (v0.1.225)

- The mobile Live welcome now gets a full eight seconds before briefly yielding
  to agent activity, and activity appears only while an agent is actually
  working — idle rooms stay on the welcome instead of cycling filler.
- The welcome is larger, while agent questions use the same clean plain-text
  treatment instead of switching the header into a bell-and-count badge.

## August 3, 2026 - A clean way out (v0.1.224)

- `lfg uninstall` now removes the LFG service, command, MCP registrations, and
  release application files while preserving sessions and config for a future
  reinstall.
- `lfg uninstall --purge --yes` is the explicit destructive path for deleting
  sessions and config too. Shared tools such as Bun, Tailscale, tmux, and agent
  CLIs are never removed, and source checkouts stay intact by default.

## August 3, 2026 - Mobile Live is a list again (v0.1.223)

- Live view on mobile no longer expands a session in place. Every session is a
  compact row — title, latest activity, status — and tapping it opens the full
  session sheet, which stays the one place to read and reply.
- The long-press-to-expand gesture is gone, along with the transcript streams
  those expanded cards kept open in the background. Desktop is unchanged.

## August 3, 2026 - A welcome with a pulse (v0.1.222)

- The mobile Live header now cycles between the personal welcome and current
  agent activity. Status appears as a smaller shimmering line, while the soft
  text swap respects reduced-motion preferences and urgent questions still
  take priority.

## August 3, 2026 - Toasts follow their edge (v0.1.221)

- Top-anchored toasts now dismiss upward through the top edge, including
  background toasts in a collapsed stack, instead of slipping downward.

## August 3, 2026 - A welcome that reflects the room (v0.1.220)

- The mobile Live welcome now keeps its compact, bell-free single line while
  showing current activity inline, using larger type, and sitting closer to the
  screen edge. When no agents are working, it switches to “Ready to build.”

## August 3, 2026 - Every artifact leads home (v0.1.219)

- Artifact cards now show the conversation that created them. Open the related
  session straight from the gallery, including finished sessions that need to
  be reviewed or resumed.

## August 3, 2026 - A quieter mobile hello (v0.1.218)

- The mobile Live welcome is now one compact line with no bell icon or
  secondary status copy. Bells, context, and the wider card remain reserved
  for agent questions that actually need attention.

## August 3, 2026 - A lighter mobile welcome (v0.1.217)

- The mobile Live welcome now sits directly on the page instead of inside a
  frosted card. The introductory LFG mark and urgent agent-question states
  still keep their pill treatment so notifications remain easy to spot and tap.

## August 3, 2026 - A Live header that knows what is happening (v0.1.216)

- On mobile, the Live header now introduces the LFG mark for two seconds and
  then turns that same island into a personal welcome using the active profile.
- The welcome stays useful after hello: it shows how many agents are building,
  changes into an urgent notification when an agent needs input, and opens the
  unified Notification Center when tapped.
- Toasts now arrive at the top center, immediately below the mobile header,
  instead of competing with the persistent composer at the bottom of the screen.

## August 3, 2026 - Faster, complete mic messages (v0.1.215)

- Releasing the mic no longer discards the realtime transcription's final
  update and then waits 1.8 seconds before sending a possibly cut-off partial.
  LFG keeps that final update connected and sends as soon as it arrives.
- Each voice take now has one explicit commit boundary. Realtime partial text
  still appears while speaking, while duplicate close-time commits are removed
  and whole-clip transcription remains a fallback only when realtime fails.

## August 3, 2026 - Pinned means protected (v0.1.214)

- Smart clear now leaves pinned sessions running while it archives the other
  idle sessions in scope. Its confirmation also calls out how many pinned
  sessions are being protected.
## August 3, 2026 - The last freeze, at startup (v0.1.213)

- Restarting LFG used to stall it for several seconds about a minute in, while
  it re-read the header of every Codex session ever recorded on the box — 3,517
  files and 1.8GB here. Those headers never change, so they are kept now: the
  first session list after a restart went from 3.9s to 0.25s.
- With that gone, yesterday's other fixes hold up on a full day of real
  traffic: requests to the session list that took over a second dropped from
  686 to effectively zero, and the ones that remained were all this startup
  stall, which is now fixed too.

## August 3, 2026 - Quieter interrupted turns (v0.1.212)

- Steering an agent mid-task no longer leaves a large synthetic
  `[Request interrupted by user for tool use]` chat bubble behind. The event
  now appears as a subtle `Interrupted` status between the surrounding turns.

## August 2, 2026 - Fewer whole-server freezes (v0.1.211)

- Listing sessions ran `pgrep` twice, forking a process to ask the operating
  system something it already publishes as files. LFG reads that directly now,
  which is about ten times faster and, more importantly, doesn't block the
  server while it happens. Today's log recorded 686 requests that took over a
  second and 220 over five — during which nothing else moved, including live
  streams and reconnects.

## August 2, 2026 - Reconnecting is quick again (v0.1.210)

- Coming back to a tab that had gone stale — after sleep, or a long spell in
  the background — made LFG wait a flat 2 seconds before it even started
  reconnecting. It now gives the old connection half a second, which is already
  generous against a server that answers in single-digit milliseconds.
- Waking up or regaining the network now restarts the retry schedule. The first
  attempt after a laptop wake usually fails because Wi-Fi hasn't come back yet,
  and the next retry was using the delay it had wound up to before sleeping —
  up to 12 seconds of sitting on "offline" over a perfectly good network.
- Reconnecting no longer rebuilds transcript history the server then throws
  away, and a tab that reconnects while another one is open now gets the
  current session list immediately instead of waiting for something to change.
- The shipped feed, artifact gallery, coding-agents page, resume sheet and
  token-usage dialog now load only when opened, taking another 39 KB out of the
  bundle you download before anything renders.

## August 2, 2026 - The app paints a third faster on a cold load (v0.1.209)

- The AI SDK that powers the chat surface was in the bundle you download before
  anything can render, even though nothing needs it until you open a session.
  It now loads in the background just after first paint, and is already cached
  by the time you open one.
- On a cold 4G load: first contentful paint 1.40s → 0.93s, DOM content loaded
  2.91s → 2.32s, and the entry bundle is 150 KB smaller.

## August 2, 2026 - The server stops re-reading itself every 2.5 seconds (v0.1.208)

- Whenever a browser is open, LFG rebuilds its session list every 2.5 seconds to
  keep the fleet status live — and that rebuild was re-reading and re-parsing
  the entire session registry about eight times over, roughly 700 file reads per
  rebuild. The server was spending around a tenth of its time in a blocking
  rebuild, permanently, which made everything else feel intermittently sticky.
- Entries are now cached and checked against the file's timestamp instead of
  being re-read, so an unchanged session costs a stat rather than a read and a
  parse. Rebuild time drops from 196ms to 45ms, and the worst pause it inflicts
  on everything else from 176ms to 58ms.
- Nothing about liveness changes: a session updated by another process is still
  picked up on the very next poll.

## August 2, 2026 - Returning home no longer repeats replies (v0.1.207)

- Opening Settings and returning Home could briefly render the same assistant
  reply and Thought block several times. The saved transcript was correct, but
  two live listeners could both accept the first event from a locally sent
  message and cache the duplicate UI state. Locally started chats now claim
  their live stream synchronously, while replies started from another device
  still appear normally.
- Starting a new session no longer pauses every other live session while LFG
  runs the Git commands that prepare its worktree. Provisioning now stays off
  the server event loop, and its remote refresh benefits the next session
  without blocking the one you just started.
- Leaving an embedded settings page no longer strips the styling from another
  surface the host still has mounted. Every packaged style is anchored to one
  attribute on the document, and the first surface to unmount removed it —
  so in a host with two surfaces alive, the visible one could drop to unstyled
  markup. The attribute is reference counted now.

## August 2, 2026 - Artifact cards follow your theme instead of your desktop (v0.1.206)

- An artifact rendered in a dark card on a light machine kept its light
  styling — dark surfaces with dark text — because it had no way to see which
  theme the card was in. The renderer now stamps `data-theme` on the artifact
  document (and on the shadow host, where theme selectors were already being
  rewritten against an attribute nothing set), so an artifact can key its dark
  styles off the card rather than off the desktop.
- Artifacts that reach for the short token names (`--lfg-artifact-bg`, `-fg`,
  `-muted-fg`) now get the theme instead of silently falling back to their own
  hardcoded colors.
- Fixed the perf report card itself, which had painted every axis label,
  legend, caption and table header with a *surface* color — invisible in both
  light and dark.

## August 2, 2026 - Sessions on a second Claude account get their tools back (v0.1.205)

- Sessions running on any Claude account other than the first started with no
  LFG tools at all — they could not narrate to the thread, ask you a question,
  publish an artifact, or ship. Each extra account has its own Claude config
  directory, but LFG only ever registered its MCP server into the default one,
  so those sessions launched mute while Setup still showed "Claude MCP ·
  registered".
- Setup now registers into every account's config directory, seeds a newly added
  account the moment you create it, and the Claude MCP check only turns green
  when all of them are covered.
- Embedded apps with two surfaces mounted at once (omg's Computer view behind
  Settings) no longer lose all their styling when you close one of them.

## August 2, 2026 - Text-to-speech removed (v0.1.204)

- Spoken replies are gone: audio mode, the floating audio player, the "speak
  this session" action hidden behind the agent avatar, and the text-to-speech
  provider setting have all been removed.
- "Audio mode · auto-play replies" had been silently broken for some time. The
  hook that fed replies to speech only existed on the older streaming transport,
  so on the default one nothing was ever spoken — while the session was still
  told to keep its answers short and speakable. Turning it on made replies worse
  and produced no audio. (The v0.1.201 note that audio mode "works exactly as
  before" was written before this was discovered.)
- Dictation is untouched: the mic button, voice messages, and the speech-to-text
  provider setting all work exactly as before. The Voice settings section now
  covers just voice input.
- Note for self-hosters: `TTS_UPSTREAM`, `TTS_TOKEN`, and the ElevenLabs/OpenAI
  TTS overrides are no longer read and can be removed from `.env`. The GPU TTS
  engines, the TTS failover timer, and the Modal voice app went with them; the
  Sakana egress proxy in `deploy/modal` stays.

## August 2, 2026 - Embedded chrome survives a settings visit (v0.1.203)

- A host that mounts both surfaces no longer has its full app corrupted by
  opening a settings page. "Renders inside the host's chrome" was a single
  process-wide flag, so a settings page set it once and every later full-app
  render lost its header, gutter and header inset until a hard reload. Each
  mounted tree declares its own now.

## August 2, 2026 - Faster session create and fork (v0.1.202)

- Starting a session no longer waits on a fetch from GitHub. Provisioning its
  worktree refreshed `origin/main` every single time — a network round trip on
  the critical path that also froze the server for its duration, so every other
  session's live updates stalled with it. It now refreshes at most once a minute
  per repository, and gives up rather than hanging if the remote is slow.
- Forking a session no longer rebuilds the whole session list just to look up
  the session you are forking from.
- Together: creating a session is about 37% faster and forking about 48% faster
  on the server side, and neither one stalls the sessions you already have open.
- Settings > Computer no longer renders with a missing header and collapsed
  gutter after you visit Settings. Two surfaces can now be open at once without
  one describing the other.
## August 2, 2026 - Phone call and voice orb removed (v0.1.201)

- The LiveKit phone-call screen and the voice orb are gone. The call UI had
  already been unreachable — nothing could open it — while still shipping about
  8 MB of 3D and realtime-audio libraries to every visitor. Audio mode, which
  speaks the current session, already covers what the call was for.
- The web bundle is roughly 8 MB smaller as a result.
- Dictation, spoken replies, audio mode, the voice provider settings, and the
  deep-think advisor behind "ask a question" all work exactly as before.
- Setting a voice API key now tells you which half you just enabled ("Voice
  messages are ready" / "Spoken replies are ready") instead of claiming all of
  voice is ready when only one provider was configured.
- Note for self-hosters: the GPU voice stacks under `deploy/` were only ever
  reachable through the call path, so `TTS_UPSTREAM` / `STT_UPSTREAM` are no
  longer read. Their READMEs now say so, and the TTS failover timer no longer
  affects anything.

## August 2, 2026 - Mounted settings pages sit in the host's column (v0.1.200)

- A settings page mounted inside another product now fills that product's
  column instead of centring a narrower one inside it. Every card previously
  sat inset from the host's own cards, and the mount read as a panel dropped
  into the page rather than part of it.

## August 2, 2026 - One number per account on the campfire (v0.1.199)

- A Claude account on the campfire no longer shows its number twice. The label
  under the icon already reads "Claude 1", so the numbered badge stamped on the
  icon was a duplicate; renamed accounts keep the badge, since their label
  doesn't say which login it is.
- The chat composer's one-line controls are centered.

## August 2, 2026 - Session creation feedback stays in its lane (v0.1.198)

- The shimmering session-creation state now covers only the rounded input card,
  leaving project, attachment, and action controls visible while LFG starts the
  session.

## August 2, 2026 - Every Claude account's usage, and a chip you can see (v0.1.197)

- A Claude account whose access token had gone stale now reports its usage
  again. Claude Code refreshes that token whenever it runs; LFG read the same
  file without running the CLI, so an account that hadn't started a session in
  the last few hours looked like it had no usage at all. LFG now refreshes the
  token itself before asking.
- The selected agent chip in the composer is actually visible in dark mode. It
  was a #2c2c2e circle on a #1c1c1e sheet — sixteen levels of grey apart, which
  on a phone reads as nothing being selected at all.

## August 2, 2026 - Reconnects stop waiting on settings (v0.1.196)

- Reopening LFG no longer freezes every request while it boots five agent CLIs
  to inspect MCP setup. Those checks now run only on the Coding agents page,
  run together without blocking live sockets or the API, and finish roughly
  three times faster when that page is opened.
- The startup payload no longer carries the entire skill catalog before the
  user asks for a skill. On this instance that removes about 106 KB over the
  wire on every cold load; slash-skill suggestions still fetch it on demand.
- The changelog moved out of the startup JavaScript and into its own on-demand
  chunk, trimming another 32 KB of Brotli-compressed code from the cold path.

## August 2, 2026 - Session creation no longer looks stuck (v0.1.195)

- Starting a session now replaces the composer with a clear, shimmering
  "Creating session…" status while LFG prepares the worktree and starts the
  agent. The mobile composer and desktop new-session drawer both stay visibly
  busy instead of clearing or disappearing with no feedback.
- The creating state blocks accidental duplicate launches. If startup fails,
  the overlay clears and the original prompt returns so it can be retried.

## August 2, 2026 - The mic responds on the first tap (v0.1.194)

- Tapping the mic now opens it immediately. Every tap used to wait on a network
  round trip before the microphone was even requested, so on a slow connection
  the browser's permission prompt could appear ten seconds late — and on iOS and
  installed PWAs that wait often broke the request outright, which is why so
  many taps did nothing at all.
- The mic button shows a spinner the moment you tap it, so it can never look
  dead while the mic is opening. Tapping again backs out instead of doing
  nothing, and Escape, the cancel X, and slide-to-cancel all work during that
  window too.
- A mic that can't start now says why — blocked permission, no microphone
  found, or the device being held by another app — instead of failing silently.
- Opening the mic can no longer hang indefinitely, and cancelling takes effect
  the instant you tap rather than after the timeout.
- Dictation no longer leaves the microphone held open (OS mic indicator lit)
  when a take is abandoned partway through.
- Dictation now asks for echo cancellation, noise suppression, and automatic
  gain control, matching what voice calls already did.

## August 2, 2026 - Claude accounts you can actually see (v0.1.193)

- Picking "Claude · Auto" in the agent picker now highlights it. The Auto entry
  was the one option that never lit up, so the composer looked like nothing was
  selected — and swiping to cycle agents or tapping to collapse the row didn't
  work from Auto either.
- The campfire no longer hides a Claude account it couldn't read. An account
  whose usage lookup fails — expired sign-in, rate limit — keeps its place on
  the arc, dimmed, with the reason underneath, instead of silently disappearing
  and leaving you to wonder where the account went.
- The composer's agent icon is centered when the composer is a single line.

## August 2, 2026 - A roomier "new version" prompt (v0.1.192)

- The post-deploy "New version available" screen no longer borrows the crash
  layout. It gets a centered icon, a title you can read, a line explaining that
  the app updated while your tab was open, and a full-width Reload button — no
  longer a tiny cluster of controls stranded on an empty black screen.

## August 2, 2026 - Sent images are their own view (v0.1.191)

- An attached image is no longer boxed inside the message bubble. The picture
  gets its own frame and the words keep theirs, stacked — the way every
  messaging client does it. Sharing a screenshot with a caption no longer reads
  as one cramped card.
- Attach an image and type nothing and the picture is the whole message, with
  no empty bubble under it. A lone image renders larger; several tile.
- Attachments with nothing to show inline (a PDF, or an image whose bytes are
  gone) now read as a proper file card rather than a tag inside a bubble.

## August 2, 2026 - Attached images show up as images (v0.1.190)

- Screenshots you attach now render as thumbnails inside your own message
  instead of a wall of `/tmp/lfg-uploads/...` paths. Sending six images used to
  fill the transcript with six file paths and nothing you could actually look
  at. Tap one to open the full-size viewer.
- A lone image widens to the bubble; several tile side by side. Attachments
  with nothing to show inline — a PDF, or an image whose bytes were cleared
  when the box rebooted — appear as a named file chip rather than a broken
  image.
- What the agent receives is unchanged: the absolute paths still travel with
  the message, so a coding agent can read the files exactly as before. Only the
  rendering changed.

## August 2, 2026 - Host-mounted settings behave like pages (v0.1.189)

- A product embedding LFG's settings pages no longer has them replaced by the
  "Connect a coding agent" prompt. That gate exists for a framed full app,
  which cannot run a session without an agent; a host that mounted a single
  settings page was shown onboarding where its settings should have been, with
  no way to reach the page at all.
- Embedded settings pages can now be routed by the host. `LfgSettingsSurface`
  reports its own navigation through `onNavigate` and accepts `page` as a
  controlled prop, so Coding agents, Schedules, Storage and More become real
  destinations in the host's URL — linkable, and with a back button that goes
  up one page instead of leaving the surface.
- A host-mounted page now shows its own shape while the machine is still
  answering, instead of painting an empty ping, "0 working" and "—" storage as
  if they were facts about the box.

## August 2, 2026 - SDK sessions survive restarts (v0.1.188)

- AI-SDK, Codex SDK, OpenCode, and Pi sessions now run as direct managed
  processes instead of using tmux as an otherwise-unused lifecycle wrapper.
  LFG journals their boot ownership, adopts them across service restarts, and
  safely reopens interrupted conversations after a host reboot without
  replaying an unfinished prompt.
- Resuming a conversation now keeps its provider/model identity together,
  repairs stale cross-provider cache rows, and ignores dead managed entries so
  a stopped harness cannot masquerade as an already-live session.

## August 2, 2026 - Claude capacity routes itself (v0.1.187)

- New and forked Claude sessions now default to `Claude · Auto`, choosing the
  connected account with the most room in its tightest usage window and pinning
  that concrete account for the session's lifetime. Explicit numbered-account
  choices remain available, while unknown capacity stays a fallback ahead of an
  account known to be exhausted.

## August 1, 2026 - Embedded terminals use their host transport (v0.1.186)

- Terminals mounted inside another product now open their WebSocket through
  the same authenticated host transport as HTTP and live transcript traffic.
  They previously inferred the socket from the embedding page URL, so OMG
  cloud Computers tried to connect to the dashboard itself and immediately
  closed instead of reaching the Computer's LFG runtime.

## August 1, 2026 - Archive wording everywhere (v0.1.185)

- Session swipe actions, keyboard confirmations, and Smart clear now consistently
  say Archive instead of Delete or End. Confirmations also make clear that an
  archived session leaves the live view but remains available to resume later
  from Recent sessions.

## August 1, 2026 - Cloud workspaces can update themselves again (v0.1.184)

- LFG running in an OMG cloud workspace can now take updates. It restarts
  itself there by exiting into the loop OMG keeps it alive with, but it was
  looking for that loop at a path OMG no longer uses, so it concluded no
  restart was possible and turned down every update before downloading it —
  leaving each workspace pinned to whatever version it was created with. The
  four free-tier workspaces we checked were sixteen releases behind, which
  means none of the recent memory and reliability work had ever reached them.
  Update now works from the Settings page as it does everywhere else.

## August 1, 2026 - One MCP server for the whole box (v0.1.183)

- Running several Claude sessions at once no longer costs a duplicate
  background process each. LFG registered itself with Claude as a stdio MCP
  server, so every session started its own copy of `lfg mcp` — around 38 MB
  apiece, and a box with 14 sessions was carrying 14 identical ones (~540 MB)
  whose only job was to forward calls to the LFG server already running beside
  them. The server now answers MCP directly at `/mcp`, and Claude is pointed
  there over HTTP, so sessions share one endpoint. Existing installs migrate
  the next time MCP setup runs; Codex, OpenCode, Grok and Cursor keep working
  exactly as before.

## August 1, 2026 - Security patches for the graph we actually ship (v0.1.182)

- Patched the vulnerable transitive dependencies in the bundle: `fast-uri`,
  `hono`, `body-parser`, `protobufjs`, `brace-expansion`, and `@hono/node-server`
  (unblocked by moving `@modelcontextprotocol/sdk` to 1.30.x, which widens its
  own range rather than forcing a major on a package that never agreed to one).
- Removed three stale `package-lock.json` files. Nothing installed from them —
  every path here uses bun — but `npm ci` would have quietly built a mid-July
  dependency graph, and they were the only thing Dependabot could see, so its 20
  alerts described a tree nobody ships.
- Added a `bun audit` workflow on push, PR, and a weekly schedule, so the real
  lockfile is watched and new high-severity advisories fail the build. Accepted
  exceptions are explicit and the full report is always printed.

## August 1, 2026 - Mounted settings sit flush with their host (v0.1.181)

- A settings page mounted in another product no longer carries LFG's own page
  layout with it. It was still applying a side gutter, a top inset reserving
  space for the header bare mode had already removed, and an absolutely
  positioned scroll box — all of which exist to accommodate LFG's chrome. The
  visible result was cards sitting inset from the host's own cards on the same
  page, with a gap above them.


## August 1, 2026 - One tick in the project picker (v0.1.180)

- The Projects sheet no longer shows a green tick next to "All projects" and a
  named project at the same time. Each row decided its own tick from a separate
  piece of state, and the composer legitimately holds both — with the live view
  unfiltered it still has to pick a concrete folder for the next session — so
  the single-choice list ended up with two answers. The tick now always follows
  the project your agent will actually work in, and "All projects" claims it
  only when no specific folder is on the hook.

## August 1, 2026 - Terminal keyboard fixes (v0.1.179)

- The pulled-up session terminal no longer jumps around when the on-screen
  keyboard opens. It was sized against the full screen height, which iOS does
  not shrink for the keyboard — it shrinks the visible area and scrolls the page
  instead — so the sheet got shoved under the keyboard and dragged along by that
  scroll. It now sits in the real visible area, and takes the whole of it while
  you're typing so you get more terminal rather than a squeezed one.
- The terminal stops flickering during that keyboard animation. It was
  re-fitting the grid and repainting the pane on every viewport sample, most of
  which report the same size; identical sizes are now ignored.
- The mobile new-session composer no longer rides the keyboard up and down
  behind the terminal sheet — it's hidden while a terminal is up, the same way
  it already hides behind the artifact viewer.
- Typing in the terminal no longer auto-capitalises. Mobile keyboards treated
  Ghostty's input as prose and sentence-cased it, turning `git status` into
  `Git status`. Autocorrect, predictions and spellcheck are off too: it types
  lowercase and Shift means Shift.

## August 1, 2026 - Per-session terminals and a vi key menu (v0.1.178)

- Every session now has its own terminal. Press `t` on the focused session (or
  pick Terminal from its ⋮ menu) to pull up a real shell already sitting in that
  session's worktree — no `cd`, no hunting for the path. It's a persistent tmux
  session per agent session, so it survives deploys and reconnects with your
  scrollback and any long-running command intact.
- The terminal is full-bleed now. The permanent on-screen key toolbar (about
  110px of chrome that sat there whether or not you needed it) is gone; all that
  remains is one slim status strip.
- The extra keys moved into a vi-style menu you summon with ⌃⇧K, the Keys
  button, or a swipe up from the bottom edge. It's modal like vi: `h j k l` for
  arrows, `e` Esc, `t` Tab, `r` ⏎, `c` ^C, `d` ^D, `p`/`n` for history, `0`/`$`
  for line ends, `g`/`G`, `u`/`f` to page, `i` to hand focus back to the shell,
  `P` to paste, `.` to repeat the last key, `:` to type any key spec (`ctrl+p`,
  `f5`, `alt+.`), `s` to stick the menu open, `q` to close. Every key is also a
  tap target with its hint shown, so phones just tap.

## August 1, 2026 - A much smaller server (v0.1.177)

- The server now starts about 130 MB lighter. Image encoding (sharp) and the
  browser engine (playwright) used to be loaded the moment the server booted,
  even though most servers never encode an image or drive a browser. They are
  loaded the first time they are actually needed instead, which takes a fresh
  server from roughly 306 MB to 176 MB of memory.
- Small machines benefit most. On a 512 MiB free-plan Cloud Computer the old
  footprint left too little room to run a coding agent beside LFG, and agents
  could be killed by the guest shortly after launch. There is now room for both.
- Nothing about image previews, shipped-post media or saved browser logins
  changes — the first use of each pays the load once and then reuses it.

## August 1, 2026 - Voice composers that stay in place (v0.1.176)

- The home and live-session chat composers now share the same growing textarea
  and maximum height. Long prompts scroll inside the field instead of expanding
  the whole home composer, so the agent and microphone controls stay anchored.
- Live voice transcription now follows the newest spoken line in both
  composers. Manual edits in the middle of a long draft keep their position and
  are not pulled back to the bottom.

## August 1, 2026 - Settings that a host can mount (v0.1.175)

- Hosts embedding LFG can mount a settings page on its own now, and it renders
  as sections only — no LFG header, brand mark, identity block or bottom nav.
  Mounted inside a product that already has its own header and account, the
  surface used to draw a second one of each, which is the duplication that
  mounting a shared surface is meant to remove in the first place.
- `?bare=1` renders that same hosted layout in a plain browser, so it can be
  checked without building the package and mounting it in a host.


## August 1, 2026 - Faster, steadier image previews (v0.1.174)

- Image messages now carry their orientation-correct width and height from the
  display tool through storage and the transcript API. Image cards reserve that
  exact aspect ratio while loading instead of jumping from a generic placeholder
  to the finished preview.
- Transcript images load a lighter WebP capped to 1080px on both axes, so tall
  screenshots no longer download thousands of invisible pixels. Opening an
  image still fetches the untouched original at full resolution.

## August 1, 2026 - Smoother sessions and agent setup (v0.1.173)

- Installed PWAs now notify you when a coding session finishes a turn, with the
  session's latest response and a direct link back to it. Notifications stay
  quiet while that session is already open on screen.
- Grok and Pi now show only the thinking levels their own CLIs accept. Stored
  higher levels are safely clamped instead of killing a Grok launch or being
  silently ignored by Pi, and Pi gains its native Off and Minimal choices.
- The skills catalog now includes installed plugin commands, including nested
  commands, so command-only plugins are discoverable in the same place as
  skills.
- Tall desktop dialogs keep their footers and action buttons inside the popup;
  long folder lists remain scrollable instead of pushing their buttons out of
  reach.
- Session landing and credential tests are now portable and safe on macOS:
  landing uses the platform's available file locker, and tests never read or
  print a developer's real Claude Keychain token.

## August 1, 2026 - Settings, regrouped (v0.1.172)

- Settings is a one-pager now. It used to be seventeen sections in a single
  scroll that mixed your account, this machine and this browser with no
  ordering, so finding anything meant reading all of it. It now goes account,
  connection, **Computer** (Coding agents · Schedules · Storage & performance),
  agent capacity, updates, More.
- **Storage & performance** is a new page. Disk capacity was already being
  reported, but only as a fourth gauge row buried in settings; it is now a
  headline read — how much of the disk is gone, how much is left — above CPU,
  agent-slice and host memory. Four live gauges no longer greet you on the
  settings root.
- **More** holds the long tail: provider limits, terminal, browser profiles,
  voice, extensions, install, and the browser-local preferences (dark mode,
  push, sound, haptics, audio mode) grouped under "This device" and labelled
  as not synced — because they never were.
- **Auto agents are now Schedules**, with a proper page title, and the timezone
  control moved onto that page. Schedules are the only thing it affects, so it
  had no business sitting on its own in settings.
- Hosts embedding LFG can now mount these settings pages directly via
  `LfgSettingsSurface` from `@lfg-dev/app`, underneath their own account and
  plan UI, instead of reimplementing them and drifting.

## August 1, 2026 - A calmer session rail (v0.1.171)

- The Claude account number now sits bottom-right on every agent icon in the
  app, matching the agent pickers and the usage campfire, so it is always in
  the same place.
- Session avatars no longer carry a green "idle" dot. Idle is the resting state
  of nearly every row, so the dots were a wall of green marking that nothing was
  happening — the rail's groups and counts already show the shape of the fleet.
  Only a session that is working right now gets a mark, and it moved to the
  top-right corner so it never competes with the account number.

## August 1, 2026 - Claude account numbers on every session (v0.1.170)

- A session pinned to a numbered Claude account now wears that number on its
  agent mark everywhere the mark appears: the rail rows, the session card and
  detail headers (the top-left icon), and the session picker. Telling which
  login a session is running on no longer means opening it.
- The number only appears once a second account is connected — with one login
  there is nothing to disambiguate — and sits opposite the busy/idle dot so
  neither signal covers the other.
- Fixed returning to LFG from another app sometimes leaving the UI packed into
  the top slice of the screen with dead space below, until a pinch or rotate
  forced a relayout. A shrunken viewport now only counts as a soft keyboard when
  something is actually focused, and the shell re-samples instead of latching a
  mid-animation reading from iOS.

## August 1, 2026 - Usage follows your Claude accounts (v0.1.169)

- Usage now reports one entry per connected Claude account. The campfire view
  (Shift, or long-press the composer rings) shows a numbered node per account,
  and Settings → Usage lists each account's own 5-hour and 7-day windows instead
  of collapsing every login into a single "Claude" row.
- Picking an account on the campfire arc starts the next session on that
  account, rather than on whichever one the composer was last left on.
- The composer's activity rings show the selected account's limits and re-read
  them when you switch accounts — previously they always showed the first
  account's numbers.
- Each usage source is now fetched independently instead of through one combined
  request. Surfaces that need a single ring make a single request (~135ms rather
  than ~300ms+ on this box), the campfire fills in agent by agent as each source
  answers instead of waiting on the slowest, and one account's refresh no longer
  re-walks the Codex sessions tree or re-hits Grok's billing API.
- A crowded arc now sizes and spaces its nodes to fit, so six or more agents
  (which multiple Claude accounts make routine) no longer overlap on a phone.

## July 31, 2026 - Multiple Claude accounts (v0.1.168)

- Connect multiple Claude subscriptions from Coding agents settings. Each login
  is isolated, numbered, and can be reconnected or removed independently.
- The new-session and fork agent pickers now show one Claude icon per connected
  account, with a small account number at the bottom-right of each icon.
- Claude sessions stay pinned to the account they started with, including after
  a restart or resume, so switching the target for a new session never changes
  the identity of work already in progress.

## July 31, 2026 - Anonymous OpenCode models are truly anonymous (v0.1.167)

- Skipping provider setup now limits OpenCode's picker to discovered
  `opencode/*-free` models. Models from credentialed providers are no longer
  shown merely because the OpenCode CLI knows their names; connecting a
  user-owned model account restores the broader discovered catalog.

## July 31, 2026 - Hosted Computer identity no longer depends on email (v0.1.166)

- An omg hosted Computer with no local user roster no longer rejects session
  creation or resume when the embedded browser remembers an account email.
  Hosted access remains owned by omg's stable account id; LFG's email field is
  treated only as optional presentation metadata.
- The embedded client now sends an owner only when it exists in the Computer's
  current roster. A changed or stale email can no longer strand create, resume,
  continue, fork, finding-reply, or session-management flows.

## July 31, 2026 - OpenCode's safe default everywhere (v0.1.165)

- New and resumed OpenCode sessions now resolve their default from the same
  live catalog shown in the picker. The server can no longer bypass the picker
  and silently launch the removed `opencode-go` provider when no model was
  supplied.

## July 31, 2026 - Hosted model choices that actually run (v0.1.164)

- Skipping account setup in an omg hosted Computer now leaves one honest
  choice: OpenCode. Claude, Codex, and other account-backed agents appear only
  after that user-owned account is connected, rather than being unlocked by
  platform proxy credentials.
- OpenCode's live model list is now authoritative. Removed providers such as
  `opencode-go` can no longer leak back into the picker from an old built-in
  catalog; before discovery completes, LFG offers the verified anonymous
  DeepSeek Flash model as its safe fallback.
## July 31, 2026 - Continue in a clean session (v0.1.163)

- Session menus now have a Continue action beside Fork. It opens a fresh agent
  with the current transcript as context, then archives the session it replaces.
- The replacement is created first, so a launch failure leaves the current
  session live instead of losing the place you were continuing from.

## July 31, 2026 - Resuming a session whose worktree was cleaned up (v0.1.162)

- Resuming certain sessions started and then immediately stopped, with nothing
  in the transcript to explain it. Affected sessions were ones whose per-session
  worktree had since been reclaimed by the automatic cleanup sweep.
- Claude files each conversation under a folder named after the directory the
  session ran in, and finds it again the same way. Once that directory was
  swept, LFG correctly fell back to the repo root — but the conversation was
  still filed under the deleted path, so Claude reported no such conversation
  and quit before the session ever came up.
- LFG now re-files the conversation under the directory it is resuming into, so
  the session comes back with its history intact. Nothing is moved or deleted;
  the original transcript stays where it was.
- If no stored conversation can be found at all, the resume now starts a fresh
  one and says so in the log, instead of failing silently.

## July 31, 2026 - Logo weight matched to the original (v0.1.161)

- The vector wordmark now sits at the same size and weight the mark had before
  it was redrawn. Converting it to vector had also made it noticeably larger and
  heavier than the logo people were used to; it reads as the familiar mark again,
  just sharp.

## July 31, 2026 - A genuinely sharp logo, and updates that actually arrive (v0.1.160)

- The LFG mark is now real vector artwork, so it is sharp at every size. It had
  been a small bitmap dressed up as an SVG since June, which no amount of
  rendering work could rescue at the 24px the header draws it at. Same wordmark,
  same colours — just drawn as outlines instead of pixels.
- Reopening the app now picks up the newest version on its own. An installed app
  is suspended rather than closed, so it could keep running one old build across
  many updates while a "Reload to get the latest" prompt waited in a screen you
  were not looking at. Resuming the app adopts a pending update instead; while
  you are actively using it, LFG still asks first.

## July 31, 2026 - The LFG logo is sharp again (v0.1.159)

- The mark in the top-left header renders crisply on iPhone and iPad again. It
  had looked soft and low-resolution since late June — long enough that it read
  as "the logo is just low-res now" rather than as a bug.
- The artwork was never the problem and has not changed. The header's frosted
  pill carried the blur on the same element that wrapped the logo, and iOS
  folds an SVG into a blurred ancestor's layer and redraws it there, softening
  it. The blur now sits on its own layer behind the pill, so the mark is drawn
  at full resolution. The frosted chrome looks exactly the same.

## July 31, 2026 - Resuming a session no longer replays your old messages (v0.1.158)

- Resuming a session after a crash or restart could re-send your entire message
  history back to the agent as if you had just typed it. The old messages
  arrived stamped with the current time, so they piled up at the bottom of the
  transcript as the "newest" thing, with the real conversation stranded above
  them — and the agent would start answering questions you asked hours ago.
- The cause was a cursor that counted the command log in bytes but compared it
  in characters. Any non-ASCII character — a "—", an "…", an arrow, an emoji,
  the smart punctuation dictated messages are full of — made the two disagree,
  which read as "the file was truncated" and rewound the cursor to the start.
  A single accented character was enough to trigger it.
- On this machine 8 of 33 live sessions were primed to do exactly that, 379
  replayed messages in total, the worst holding 247. All four agent backends
  shared the bug; all four are fixed and covered by tests.
- Sessions now remember how far they got. Messages you send while the server is
  down or restarting are delivered when it comes back, instead of being silently
  dropped — previously the only protection against replay was to skip everything
  that arrived while the session was away.

## July 31, 2026 - Dismiss a question you're not going to answer (v0.1.157)

- "Needs you" questions in the Notification Center can now be dismissed. The
  X on each card was there but invisible — hidden behind a hover state that
  desktop overrode and phones can't trigger at all — so the only way to clear
  a question was to answer it, while it kept the badge lit.
- The dismiss button is always visible now, with a proper tap target, and a
  "Dismiss all" clears a stack of them at once. Bulk dismissal asks for a
  second tap to confirm, since every waiting agent moves on.
- Answering or dismissing a question also takes down its phone notification.
  Those banners are sticky by design, so they used to linger on the lock
  screen long after the question was handled.

## July 31, 2026 - A folder picker you can actually scroll (v0.1.156)

- The Projects sheet shows far more at a glance. The list was boxed into a
  window barely two rows tall; it now opens to roughly eight, so most people
  see every project without scrolling at all.
- Folder paths are hidden by default behind a "Paths" toggle in the sheet
  header. The project name is usually all you need, and dropping the second
  line makes each row about a third shorter. Your choice is remembered.
- Swiping the list scrolls the list. Before, a flick inside that short window
  usually grabbed the sheet instead and dragged it closed.
- With more than seven projects the sheet adds a search box, so a long list is
  a quick type instead of a long scroll.

## July 31, 2026 - Sign in to Grok from the browser (v0.1.155)

- Connecting Grok no longer needs the terminal. Login on the Grok row now opens
  the x.ai approval page directly, shows the one-time code, and detects approval
  on its own — the same flow Claude and Codex already use.
- The approval page opens with the code already filled in, so there is nothing
  to copy across; just check it matches what LFG shows.
- Grok now reports "connected" only when a sign-in token is actually saved.
  Before, it counted the `~/.grok` folder as proof, so it could claim you were
  signed in when you were not.

## July 31, 2026 - One notification inbox (v0.1.154)

- Questions from agents now appear at the top of Notifications and are answered
  right there — tap a suggested option or type a reply. The separate Ask page is
  gone; `/ask` opens Notifications.
- Notifications are far more compact: one row per item with a small media
  thumbnail instead of a full-width gallery, grouped under Today / Yesterday.
  About three times as many fit on a phone screen.
- The "Follow up" button is gone from notification cards. Opening a notification
  takes you to the session, where forking already lives.
- The feed loads faster and lighter: images download at thumbnail size rather
  than full resolution, the list only sends what it shows, and a backgrounded
  tab stops polling.

## July 31, 2026 - Jump to latest stays reachable (v0.1.153)

- The scroll-to-latest pill no longer disappears behind the "files changed /
  Review" bar. When a session has diffs, the pill stacks just above the diff
  bar so you can always jump back to the newest activity.

## July 31, 2026 - Hosted composers send to the selected Computer (v0.1.152)

- Fixes the embedded text composer sending messages to the host dashboard
  instead of the selected LFG Computer. Hosted and custom-connected Computers
  now send through the same authenticated transport as every other session
  action.

## July 31, 2026 - See what each session is using (v0.1.151)

- Restores Token usage to the session menu, opening a focused inspector for
  current context consumption and cumulative model traffic.
- Breaks usage down into input, output, cache, reasoning, tools, skills, system
  prompt, and message categories, while clearly distinguishing provider-reported
  totals from estimated attribution.
- Reads live Codex and Claude session counters when they are available and
  degrades to an explicit unavailable state for agents without token telemetry.

## July 30, 2026 - A real notification center (v0.1.150)

- Rebrands the Shipped page as Notifications, with a canonical
  `/notifications` route while preserving old Shipped links.
- Shipped results now appear as a notification type with per-profile unread
  state. Opening one marks that item read, and Mark all read clears every unread
  marker plus the PWA app-icon badge without deleting notification history.
- Stops silently clearing the PWA badge when the app merely returns to the
  foreground; acknowledgement now happens explicitly inside Notifications.

## July 30, 2026 - Notification dots that know when you are back (v0.1.149)

- The PWA notification dot now clears automatically when LFG opens or returns
  to the foreground, including when a push arrives while the app is already in
  use. Questions, findings, and shipped results remain in their normal in-app
  surfaces until handled.
- Removes the manual notification-dot control from Settings; clearing the OS
  alert is now part of reviewing the app rather than a maintenance task.

## July 30, 2026 - Send and move on (v0.1.148)

- Sending from either mobile composer now dismisses the field focus so the
  on-screen keyboard closes instead of staying in the way.
- Settings now includes a one-tap way to clear the installed PWA's notification
  dot and mark its visible notifications as handled.

## July 30, 2026 - The app appears before it connects (v0.1.147)

- Replaces the full-screen startup spinner with the real LFG interface. While
  bootstrap data is connecting, controls are visibly and semantically disabled;
  they become interactive automatically as soon as the app is ready.

## July 30, 2026 - Shipped notifications open the work (v0.1.146)

- Shipping a result now sends the session owner a push notification with the
  result title and summary. Tapping it opens that exact session for review,
  including when the LFG app is already open.
- Installed PWAs show a badge for visible LFG notifications and clear it once
  the notifications are handled on platforms that support app badging.

## July 30, 2026 - Cleaner navigation islands (v0.1.145)

- Moves Settings into the Pages menu and removes the separate gear from the
  mobile right island and desktop session rail, keeping all page destinations
  in one predictable dropdown without exposing host-owned settings in embeds.

## July 30, 2026 - One project chip on hosted mobile, not two (v0.1.144)

- Removes the project chip from the top-right of the hosted mobile header. The
  composer at the bottom already carries one, both are wired to the same state,
  and on a phone-width header that meant the same folder name printed twice.
  This also brings hosted in line with the plain mobile header, which has never
  shown the chip.
- Keeps "All projects" reachable: it was never part of the mobile swipe cycle,
  so the project menu used to be the only way back to it. The composer's own
  project sheet now offers it, the same row the desktop rail's sheet has.

## July 30, 2026 - Fixes the hosted home-screen crash (v0.1.143)

- Fixes the crash that replaced the whole app with an error screen on the hosted
  surface. The recent-shipped list spread the response of `/api/shipped`
  directly during render, so a proxied workspace answering 2xx without a posts
  array — an error envelope, an empty body, or a wake response while it was
  still asleep — took the entire app down with "Spread syntax requires
  ...iterable not be null or undefined".
- Hardens the Shipped feed and Artifacts gallery against the same class of
  response, so a workspace that answers oddly shows an empty list instead of
  losing the whole page.

## July 30, 2026 - A real crash screen, and crashes that report themselves (v0.1.142)

- Replaces the raw error strip a render crash used to fall through to — a bare
  "Something went wrong!" headline over a red monospace box — with a proper
  screen: what broke, Retry, Reload, a one-tap Copy of the full details, and the
  stack tucked behind a disclosure instead of shouted at you.
- A crash caused by a stale build now says so ("New version available") and
  leads with Reload, because that is the actual fix.
- Render crashes are reported again. The app's own router boundary was catching
  them before any error boundary could, so nothing was recorded — a crash could
  hit a hosted user and leave no trace anywhere. It now files the report itself,
  and only claims "Reported to lfg" when a report really went out.
- Embedded surfaces can be given a central error sink by their host, so a crash
  still gets recorded when the workspace behind the connection is asleep.

## July 30, 2026 - PWA icon cache refresh (v0.1.141)

- Forces one safe service-worker takeover to remove the stale app shell that
  could leave an installed iOS PWA or controlled browser tab rendering the old
  fragmented header icon even after v0.1.138 was deployed.
- Gives the crisp small icon an explicit versioned URL, so Safari, the PWA
  worker, and the HTTP cache cannot reuse older artwork under the same key.
  Later releases return to the normal user-approved update flow.

## July 30, 2026 - Theme-aware artifacts (v0.1.140)

- HTML artifacts can now use LFG's semantic palette for backgrounds, surfaces,
  text, borders, accents, muted content, and code, so the same artifact follows
  the app's light or dark appearance.
- Native Shadow DOM artifacts inherit the live host theme, while interactive
  artifacts receive the same palette inside their isolated sandbox.
- Deliberately authored colors still take precedence, preserving branded and
  self-styled artifacts instead of forcibly recoloring them.

## July 30, 2026 - Quieter error reporting (v0.1.139)

- ResizeObserver delivery notices no longer appear as high-severity findings,
  send push notifications, or claim an auto-fix agent was dispatched. The
  browser and server now share one noise policy, while real observer-related
  application errors remain reportable.
- Session transcript choices now live under the clearer **Display** menu
  without the outdated Experimental badge.

## July 30, 2026 - Crisp LFG mark at small sizes (v0.1.138)

- Keeps the original pixel-dissolve icon while giving 24–40px UI placements
  their own explicit small-size vector. iOS can no longer choose the detailed
  large artwork and shrink its dissolve pixels into unreadable horizontal
  fragments.
- The app header, onboarding, connect gate, and install prompt now use that
  deterministic small mark; large icons and splash artwork stay unchanged.

## July 30, 2026 - Hosts get a slot in the desktop rail (v0.1.137)

- Adds a `rail-footer` host slot at the bottom of the hosted desktop rail. A
  host embedding LFG as its entire desktop surface had nowhere to put its own
  top-level navigation, because that layout suppresses the app header and the
  rail's top row is already full.
- The slot is a real node the host portals into, so it moves with the rail
  instead of floating over it and having to track its width, collapse
  animation and position. It carries the collapsed flag so the host can stack
  vertically in the 56px rail.
- Unfilled slots collapse to nothing, so standalone LFG and hosts that ignore
  the slot are unaffected.

## July 30, 2026 - Hosts can reserve the top-right corner (v0.1.136)

- Adds `--lfg-host-top-inset`, the top-right counterpart to the existing
  `--lfg-host-bottom-inset`. The embedded mobile header now pads its right
  gutter by that amount, so a host floating its own nav island in that corner
  slides our project picker out of the way instead of colliding with it.
- Host-driven rather than hardcoded: it defaults to `0px`, so standalone LFG
  and any host that floats nothing up there reserve nothing, and the host sets
  the real width on its own surface wrapper.

## July 30, 2026 - Original LFG icon restored (v0.1.135)

- Restores the distinctive pixel-dissolve LFG mark across the app, PWA, touch
  icon, and README after the smoother replacement lost too much of its identity.
- Keeps the shared icon generator and asset checks, so the restored artwork
  remains consistent at every required published size.

## July 30, 2026 - Shipped and Artifacts are reachable on desktop (v0.1.134)

- The desktop sidebar gains a pages menu, so Shipped and Artifacts can be opened
  from the rail in both its expanded and collapsed states. Artifacts previously
  had no desktop entry point at all.
- The current page is marked in that menu, and extension tabs appear there too —
  they were previously only reachable through the Settings page.
- Opening Shipped or Artifacts inside a hosted Computer no longer leaves the page
  with no navigation and no way back to Live.
- Fixes hosted sessions briefly showing LFG's own account chrome and profile
  picker after switching pages.

## July 30, 2026 - Crisp LFG icon (v0.1.133)

- The LFG mark now uses smooth vector lettering instead of a coarse pixel grid,
  so it stays clean in the mobile header, onboarding, browser chrome, and larger
  installed-app surfaces.
- PWA, maskable, Apple touch, and README icons are generated from the same
  vector sources to keep every published size consistent.

## July 30, 2026 - Managed transcript recovery (v0.1.132)

- Managed Claude sessions no longer show "session transcript not found" when a
  task mentions flags such as `tsc -p` or `claude --print`.
- Existing affected sessions automatically reconnect to their intact native
  transcript after LFG updates, without losing conversation history.

## July 30, 2026 - Live upload progress restored (v0.1.131)

- File attachments once again show smooth, real byte-by-byte upload percentages
  and progress bars instead of sitting at 0% and jumping to complete.
- Embedded omg.dev uploads keep their authenticated runtime routing while
  reporting progress, including safe token refreshes during an upload.

## July 30, 2026 - Unified mobile session rows (v0.1.130)

- Regular mobile session cards now match the taller Recently shipped row height
  for a more consistent, easier-to-scan feed.
- Recently shipped rows show their source session title instead of repeating
  the project already selected for the page.

## July 30, 2026 - Interactive artifacts run on open (v0.1.129)

- Artifacts that draw themselves with scripts now run immediately in an isolated
  sandbox instead of waiting for an Interactive button, so a live dashboard or
  clickable prototype is interactive the moment you open it.
- Static artifacts keep rendering as real DOM, so they still share the app's
  scroll, text selection and layout, and cost no separate document.
- Gallery tiles stay lightweight previews and mark scripted artifacts with an
  Interactive badge rather than showing a half-drawn chart.
- Fixes a ResizeObserver warning that could surface as an error toast under
  artifact embeds.

## July 30, 2026 - Tighter mobile composer (v0.1.128)

- The mobile new-session composer now sits closer to the feed, removing the
  oversized empty band while preserving side spacing, touch comfort, and the
  device safe area.

## July 30, 2026 - Native artifact rendering (v0.1.127)

- HTML artifacts now render as real DOM in a shadow root instead of a sandboxed
  iframe, so the Shipped feed, the Artifacts gallery, transcript embeds and the
  full-page viewer all share the app's own scroll, text selection and layout.
- Artifact styles stay contained in both directions, and embeds size themselves
  to their real content height — the polling height reporter is gone.
- Artifacts that contain scripts show an Interactive control that runs them in
  an isolated sandbox on request; artifact JavaScript never runs in the app.
- The Shipped feed shows a real preview of each HTML artifact instead of a
  filename row, and pulls far less to paint: image tiles use generated previews
  instead of full-size originals, and videos load when played rather than on
  first paint.
- Feed and gallery refreshes now poll a single page instead of re-downloading
  everything already loaded.

## July 30, 2026 - Inline expired-login recovery (v0.1.126)

- Sessions whose Claude or Codex login expires now show the provider sign-in
  flow directly above the failed turn instead of leaving a dead authentication
  error in the transcript.
- Browser approval, one-time codes, and successful reconnect guidance reuse the
  existing account flow so users can sign back in and retry without leaving the
  session.

## July 30, 2026 - Recently shipped on mobile (v0.1.125)

- Mobile Live now shows the five most recent shipped sessions in a compact
  section below active work, scoped to the selected project.
- Finished sessions open in the normal transcript view, and a View all shortcut
  jumps directly to the complete Shipped feed.

## July 30, 2026 - Dynamic free OpenCode models (v0.1.124)

- OpenCode's live `opencode/*-free` catalog entries now remain available in
  model pickers instead of being dropped by LFG's curated catalog.
- Computers without a connected Claude or Codex account automatically select
  a currently available free OpenCode model; connected accounts keep the
  authenticated default.

## July 30, 2026 - Focused agent updates (v0.1.123)

- Session menus now offer an experimental global **User + LFG output** view
  that keeps user turns and agent-delivered updates readable while hiding
  internal reasoning, routine tool calls, and ordinary assistant chatter.
- Images, videos, and live dashboards remain visible in the focused view, and
  the selection follows the shared LFG settings across sessions and devices.

## July 30, 2026 - Smart mobile bottom fade (v0.1.122)

- The mobile composer wash now disappears at the end of the page and eases back
  in over the preceding 24px, keeping the final session card fully clear.

## July 29, 2026 - Safer session actions (v0.1.121)

- Idle sessions no longer show a Stop action that cannot do anything.
- Ending a live session is now labeled Archive session and confirms with a
  second animated click inside the menu instead of opening a dialog.

## July 29, 2026 - Remembered project folders (v0.1.120)

- Hosted LFG workspaces now reopen on the last selected project instead of
  resetting to All projects and showing sessions from every folder.

## July 29, 2026 - Crisp mobile LFG mark (v0.1.119)

- The self-hosted mobile header now keeps its LFG logo outside the backdrop-blur
  layer, preserving the pixel-art mark's sharp edges on iOS.

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
