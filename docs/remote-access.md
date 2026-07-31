# Remote access

`lfg serve` binds to loopback and has no application-layer auth of its own — it
trusts whatever network perimeter you put it behind. There are two supported
ways to reach it from your phone or laptop.

| | [Tailscale](#tailscale-recommended) | [Relay (`lfg connect`)](#relay-lfg-connect) |
| --- | --- | --- |
| Inbound port | none | none |
| Who you trust | your tailnet | the relay operator's auth |
| Works on a public origin | no (private `100.x` address) | yes |
| Setup | `LFG_TAILSCALE_SERVE=1 lfg setup` | `lfg connect <code>` |

## Tailscale (recommended)

```bash
LFG_TAILSCALE_SERVE=1 lfg setup
```

This keeps `lfg` bound to loopback and lets `tailscale serve` front it on your
tailnet. Nothing is exposed to the public internet, and your devices reach the
UI at the box's Tailscale hostname.

## Relay (`lfg connect`)

> **Experimental.** The CLI marks this command experimental; the wire protocol
> may still change.

`lfg connect` lets an *operator-run relay* reach this box without opening any
inbound port: the box dials **out** to the relay over a WebSocket and holds it
open, and the relay's own auth (a pairing code, then a persisted bearer token)
is the boundary.

No relay implementation ships with LFG. This is the generic client half of a
documented protocol any relay operator can implement — see the wire protocol at
the top of [`src/commands/connect.ts`](../src/commands/connect.ts).

```bash
# redeem a one-time pairing code, then stay connected
LFG_RELAY_URL=wss://your-relay.example/connect lfg connect ABC123

# resume the saved binding (e.g. after a restart) — no code needed
LFG_RELAY_URL=wss://your-relay.example/connect lfg connect

lfg connect status       # show the current binding, if any
lfg connect disconnect   # drop the saved binding locally
```

`LFG_RELAY_URL` is required and has no default — this must never hardcode a
specific operator's relay.

Run it under a process supervisor (systemd, `pm2`, etc. — not bundled) for a box
that should stay connected: a bare `lfg connect` re-invocation resumes the saved
binding on its own, so a crash or reboot recovers without operator action.

The saved binding token lives in `data/relay-credentials.json` (mode `0600`). If
the relay reports the token invalid, expired, or revoked, reconnecting stops and
asks you to re-pair with a fresh code rather than retrying forever.

### Why a relay at all, when Tailscale exists

A tailnet box resolves to a private `100.x` address, and a browser on a public
origin is forbidden from loading it (Chrome Private Network Access). So if you
want a *public* web origin to render a session hosted on your box, the bytes
have to come back over an outbound socket. That is what the relay's WebSocket
tunnel is for. If you only ever open the UI from your own devices, Tailscale is
simpler and you do not need this.

## Session lifecycle events (opt-in)

Set `LFG_CONNECT_EVENTS=1` to also forward a small `event` frame up the relay
socket whenever a local session finishes (`session.completed`) or needs a human
(`session.needs_attention` — model unavailable, out of credits, provider
auth/error; see `computeStatus` in [`src/sessions.ts`](../src/sessions.ts)).

This is polled locally against this box's own `GET /api/sessions` every
`LFG_CONNECT_EVENTS_INTERVAL_MS` (default `4000`) and is only sent while a relay
connection is open. See the "Session lifecycle events" doc block at the top of
[`src/commands/connect.ts`](../src/commands/connect.ts) for the exact transition
rules and wire shape.

**Not every transition is forwarded, even with the flag on.** Two sanity
defaults apply client-side, for any relay operator, before a frame is ever
built:

- A session with a `parentSessionId` (a subagent) never forwards. Subagent churn
  on a busy box is routine and constant, and forwarding it would make every
  internal step of someone else's task look like a top-level notification.
- A `session.completed` for a session that ran under
  `LFG_CONNECT_EVENTS_MIN_DURATION_MS` (default `60000`) is dropped — a
  one-minute-or-shorter run isn't news.

`session.needs_attention` is exempt from that duration floor: a blocked session
is actionable regardless of how young it is. See `isTopLevelSession` /
`isReportableTransition` in [`src/commands/connect.ts`](../src/commands/connect.ts).

**Privacy.** This is off by default because the event includes the session's
title (derived from your own first prompt in that session) and project/agent
name, which then leave this box for whatever relay `LFG_RELAY_URL` points at.
The top-level/60s filter narrows *which* transitions can trigger that, but
doesn't change what leaves the box once one does — a forwarded event's title is
still your own raw prompt text, verbatim.

## Related variables

| Variable | Purpose |
| --- | --- |
| `LFG_RELAY_URL` | Relay WebSocket URL for `lfg connect`. Required — no default. |
| `LFG_CONNECT_EVENTS` | Set to `1` to forward session lifecycle events. Off by default. |
| `LFG_CONNECT_EVENTS_INTERVAL_MS` | Local session-poll interval in ms (default `4000`). |
| `LFG_CONNECT_EVENTS_MIN_DURATION_MS` | Minimum session duration for a forwarded `session.completed` (default `60000`). Does not apply to `session.needs_attention`. |
