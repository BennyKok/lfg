# Embed host protocol

LFG runs framed inside omg's Computer surface (`https://<box>/?embed=1`). Embed
mode hides LFG's own header, settings, user picker and onboarding — the host
owns account UX. This document is the contract between the two.

## Detection

`?embed=1` on the frame URL is the explicit signal; running inside a
cross-origin iframe is accepted as defence in depth. See `web/src/lib/embed.ts`.

## Host → frame

| Message | Meaning |
| --- | --- |
| `{ type: "omg:computer-host-resume" }` | The host tab returned to the foreground. LFG restarts infinite CSS/WAAPI animations that WebKit left suspended (`web/src/embedded-animation-recovery.ts`). |

## Frame → host: `lfg:session-created`

Embedded LFG posts exactly one message, when the framed user creates a session
from this tab:

```js
window.parent.postMessage(
  { type: "lfg:session-created", sessionId: "<lfg session id>" },
  hostOrigin, // never "*"
)
```

- **Emitted from** `markCreatedSid()` in `web/src/App.tsx` — the single funnel
  every in-tab `/api/sessions/new` call already goes through. There is no
  second emitter and no new state owner.
- **Emitted when** embed mode is on (`readLocationEmbedFlag()`), the frame has
  a real parent window, and a target origin resolved. Sessions created outside
  this tab (iMessage, CLI, subagents) do not produce the event.
- **Payload** is the two fields above and nothing else. LFG does not read a
  reply, keep host state, or own any billing/upgrade UI — the host decides what
  to do with the signal (e.g. showing its upgrade prompt after the user's first
  session).

### Target origin

Resolved once at document load (`web/src/lib/embed-host-signal.ts`), in order:

1. `?embedOrigin=<absolute http(s) URL>` on the frame URL — an explicit opt-in
   for hosts whose `Referrer-Policy` strips the referrer. Read straight from
   `window.location` at boot, because the router only keeps its typed search
   params (`session`, `embed`) in the URL.
2. `document.referrer` — the embedding page for a framed document.

Only `http:`/`https:` origins are accepted. If neither source yields one, LFG
stays silent rather than posting to `*`.

### Host side

```js
window.addEventListener("message", (event) => {
  if (event.origin !== computerFrameOrigin) return       // the box's origin
  if (event.source !== computerIframe.contentWindow) return
  if (event.data?.type !== "lfg:session-created") return
  onFirstSessionStarted(event.data.sessionId)
})
```

## Embedded first-run gate

With settings and onboarding hidden, a fresh box has no place to connect a
coding agent. When neither Claude nor Codex is connected, embedded LFG shows a
single card offering those two
(`web/src/components/embedded-connect-gate.tsx`). It drives the existing
`/api/coding-agents/:kind/auth` login and the shared auth dialog; once either
provider reports `configured` (on the CLI kind or its ai-sdk sibling), the card
disappears and the normal session UI renders. Standalone LFG is unchanged — it
still uses `OnboardingFlow`.

The predicate is deliberately scoped to those two providers rather than "any
configured agent": the agent-lfg image ships pi bundled and may carry
OpenCode/Copilot credentials, which would otherwise mark a fresh Computer as
ready and skip the connect prompt the user still needs. A "Skip for now" link
covers people intentionally working on one of those other providers; it is not
persisted, so the gate returns on the next load while nothing is connected.
