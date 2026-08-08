# Remote access

`omg serve` binds to loopback and has no application-layer auth of its own — it
trusts whatever network perimeter you put it behind. The two underlying paths
are Tailscale or a relay; OMG's CLI is the one-command setup for its hosted
relay, while `omg connect` remains the generic path for any operator.

| | [Tailscale](#tailscale-recommended) | [OMG relay](#omg-relay) | [Custom relay](#custom-relay) |
| --- | --- | --- | --- |
| Inbound port | none | none | none |
| Who you trust | your tailnet | OMG auth | the relay operator's auth |
| Works on a public origin | no (private `100.x` address) | yes | yes |
| Setup | `OMG_TAILSCALE_SERVE=1 omg setup` | `omg connect` | `omg connect <code>` |

## Tailscale (recommended)

```bash
OMG_TAILSCALE_SERVE=1 omg setup
```

This keeps OMG bound to loopback and lets `tailscale serve` front it on your
tailnet. Nothing is exposed to the public internet, and your devices reach the
UI at the box's Tailscale hostname.

## Relay (`omg connect`)

> **Experimental.** The CLI marks this command experimental; the wire protocol
> may still change.

`omg connect` lets an *operator-run relay* reach this box without opening any
inbound port: the box dials **out** to the relay over a WebSocket and holds it
open, and the relay's own auth (a pairing code, then a persisted bearer token)
is the boundary.

No relay implementation ships with OMG. This is the generic client half of a
documented protocol any relay operator can implement — see the wire protocol at
the top of [`src/commands/connect.ts`](../src/commands/connect.ts).

### OMG relay

After signing in once with `omg login`, run:

```bash
omg connect
```

The OMG CLI installs OMG when it is missing, discovers OMG's public relay URL,
mints a short-lived pairing code for the authenticated account, and invokes
`omg connect` without exposing the code to the clipboard. Later runs resume the
saved OMG binding. Use `omg connect --new` only when you intentionally want a
fresh binding, or `--no-install` to require an existing OMG install.

Install the command with `npm install --global @omg-dev/cli` (or
`bun add --global @omg-dev/cli`). This convenience wrapper is operator-specific;
the OMG command and wire protocol below remain provider-agnostic.

### Custom relay

```bash
# redeem a one-time pairing code, then stay connected
OMG_RELAY_URL=wss://your-relay.example/connect omg connect ABC123

# resume the saved binding (e.g. after a restart) — no code needed
OMG_RELAY_URL=wss://your-relay.example/connect omg connect

omg connect status       # show the current binding, if any
omg connect disconnect   # drop the saved binding locally
```

`OMG_RELAY_URL` is required and has no default — this must never hardcode a
specific operator's relay.

Run it under a process supervisor (systemd, `pm2`, etc. — not bundled) for a box
that should stay connected: a bare `omg connect` re-invocation resumes the saved
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

Set `OMG_CONNECT_EVENTS=1` to also forward a small `event` frame up the relay
socket whenever a local session finishes (`session.completed`) or needs a human
(`session.needs_attention` — model unavailable, out of credits, provider
auth/error; see `computeStatus` in [`src/sessions.ts`](../src/sessions.ts)).

This is polled locally against this box's own `GET /api/sessions` every
`OMG_CONNECT_EVENTS_INTERVAL_MS` (default `4000`) and is only sent while a relay
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
  `OMG_CONNECT_EVENTS_MIN_DURATION_MS` (default `60000`) is dropped — a
  one-minute-or-shorter run isn't news.

`session.needs_attention` is exempt from that duration floor: a blocked session
is actionable regardless of how young it is. See `isTopLevelSession` /
`isReportableTransition` in [`src/commands/connect.ts`](../src/commands/connect.ts).

**Privacy.** This is off by default because the event includes the session's
title (derived from your own first prompt in that session) and project/agent
name, which then leave this box for whatever relay `OMG_RELAY_URL` points at.
The top-level/60s filter narrows *which* transitions can trigger that, but
doesn't change what leaves the box once one does — a forwarded event's title is
still your own raw prompt text, verbatim.

## Related variables

| Variable | Purpose |
| --- | --- |
| `OMG_RELAY_URL` | Relay WebSocket URL for `omg connect`. Required — no default. |
| `OMG_CONNECT_EVENTS` | Set to `1` to forward session lifecycle events. Off by default. |
| `OMG_CONNECT_EVENTS_INTERVAL_MS` | Local session-poll interval in ms (default `4000`). |
| `OMG_CONNECT_EVENTS_MIN_DURATION_MS` | Minimum session duration for a forwarded `session.completed` (default `60000`). Does not apply to `session.needs_attention`. |
