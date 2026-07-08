# Live WebSocket Consolidation — design (clean-room)

Status: design / not yet implemented.

Provenance: This protocol is **independently implemented for lfg**. Its channel/
resume design is *inspired by* the architecture of our separate realtime work
(multiplexed subscriptions, seq-ring replay, snapshot/gap semantics) but contains
**no copied code** from any closed-source repository. Implementers MUST work only
from this document and lfg's own existing code (`src/live-ws.ts`,
`web/src/useLiveSocket.ts`). Do NOT open or copy from other repos.

## Goal
Move ALL remaining live/polling traffic onto the single existing `/api/live/ws`
socket so the app is fully socket-driven: fewer connections, lower latency, no
HTTP/1.1 head-of-line starvation, and one consistent reconnect/resume story.

## Currently on the socket
Per-`sid` transcript backlog (`batch`) + incremental (`msg`), merged `status`,
and `busy`/`prompt`/`queue`/`ai_part`/artifact events. Heartbeat ping/pong 25s.

## Still OFF the socket (to migrate)
1. Agent auto-run streams — SSE `/api/agents/{agent}/runs/{runId}` (App.tsx ~3589)
2. Session summary — fetch stream `/api/sessions/{sid}/summary/stream` (~8334)
3. Load-older pagination — REST (App.tsx ~2645/2742); socket already has `backfill`
4. Polling loops — resumable sessions, ask-center, TermView (2s), version check (60s)

## Protocol evolution — generalize sid → channels
Today every frame carries `sid`. Generalize to a **channel** so any stream type
rides the one socket, distinguished by `(kind, key)`:

- channel kinds: `transcript` (key=sid), `status` (key="*"), `agent_run`
  (key=runId), `summary` (key=sid), `resumable` (key="*").
- Keep `sid` as an alias for `channel:{kind:"transcript",key:sid}` for back-compat
  during migration; do not break the existing transcript path.

### Client → server
- `{t:"subscribe", channels:[{kind,key,resumeFromSeq?}]}`
- `{t:"unsubscribe", channels:[{kind,key}]}`
- `{t:"backfill", kind, key, before, limit}`
- `{t:"pong"}`

### Server → client (every frame carries `{kind,key,seq}`)
- `snapshot` — full current state for a channel (replace local). Replaces today's
  `batch` for transcript; used for status/resumable/agent_run initial state.
- `delta` — one incremental change (`msg`, a status row change, a run event…).
- `resumed` — `{kind,key,fromSeq,toSeq,replayed}` boundary after a replay.
- `gap` — `{kind,key}` sentinel: ring didn't cover `resumeFromSeq`; client must
  treat next `snapshot` as authoritative and drop optimistic incremental state.
- `page` — backfill reply.
- `error` — `{kind?,key?,code,message}`.
- `ping`.

## Ordering & resume (the fix for "message vanished then reappeared")
- Per-channel **monotonic seq**, stamped on every emitted frame.
- Server keeps a bounded **ring buffer** per channel (cap ~256) of recent deltas.
- On (re)subscribe with `resumeFromSeq`:
  - ring covers it → replay missed deltas, then `resumed`.
  - else → send fresh `snapshot` (no `resumed`).
- Client persists `lastSeq` per channel; distinguishes replay vs snapshot purely
  by which frame arrives next.
- IMPORTANT correctness rule: an in-progress/interrupted message that is later
  finalized must be emitted as a `delta` that REPLACES the prior version by stable
  message id — never silently skipped by advancing the cursor past it. The client
  merges deltas by message id, upserting (not dropping) so an interrupted turn
  stays visible continuously. (This is the root-cause class of the interrupt bug.)

## Backpressure / batching (improve on the reference)
- Server-side coalescing window (~30–50ms) per hot channel: collect deltas and
  flush as one framed array to cut frame count on bursts.
- Client coalesces into a ref and flushes on requestAnimationFrame.

## Reconnection (client)
- Exponential backoff min(30s, 500ms·2^min(attempt,6)) + jitter; pause when tab
  hidden; immediate retry on `online` / visibility→visible.
- Re-send full current subscription set (with per-channel `resumeFromSeq`) on open.
- Refresh auth token on every reconnect; bounded 401 retries (~4) to survive
  auth-hydration races after reload; 403/400 fatal.
- Surface state to the sonner toast layer already added (reconnecting+code,
  offline+retry, reconnected).

## Auth
- Browsers can't set WS headers → pass the bearer as a **subprotocol**
  `Sec-WebSocket-Protocol: lfg-bearer.<token>`; server echoes via handleProtocols
  and verifies on upgrade with the same check the HTTP API uses. (Match lfg's
  current auth model; today's live endpoints are effectively unauthenticated in
  this tree — keep parity, don't regress.)

## Caveats to honor
- Per-channel seq is in-memory per-process → resets on server restart; a resuming
  client then gets a `gap`+`snapshot`. Fine for lfg's single-node model; document
  it. Do NOT assume seq survives a redeploy.
- Ring buffers are memory-only; size them per channel type.

## Rollout
- Additive & flag-gated. Migrate one stream at a time behind the existing
  `LIVE_TRANSPORT` gate (or a sub-flag), keeping the SSE/REST/poll fallback intact
  until each channel is proven. Order: agent_run → summary → load-older(backfill)
  → status/resumable polls. Verify each E2E (drop→resume, no dupes/gaps) before
  the next.

## Definition of done
Zero EventSource/`/api/live/status`/agent-run-SSE/summary-stream and the named
poll loops remain in the client when `LIVE_TRANSPORT=ws`; all ride one socket with
seq-resume; interrupt bug cannot recur (covered by the upsert-by-id rule + a test).
