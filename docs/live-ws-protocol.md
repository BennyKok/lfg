# Live WebSocket Protocol (single-socket rewrite)

Replace the per-idset-reopened SSE streams (`/api/live/stream` + `/api/live/status`)
with ONE long-lived WebSocket per client. Subscribe/unsubscribe are messages, not new
connections — no teardown/reopen churn (~900ms saved per expand/collapse/switch).
Target: sub-second to first rendered message on a warm client; zero reconnects on id-set change.

## Endpoint
`GET /api/live/ws` — HTTP Upgrade via Bun.serve `websocket` handler. Follow the existing
PTY/STT WS handler (~src/commands/serve.ts:1283) for upgrade + auth. Same cookie/token auth
as the SSE handlers; reject upgrade 401 if unauthenticated.

## Client → Server (JSON, `t`=type)
- {"t":"subscribe","ids":[..]} — add sids; server sends `batch` (backlog limit 40) per newly
  added sid, then streams `msg`. Idempotent; re-subscribe is a no-op unless {"resync":true}.
- {"t":"unsubscribe","ids":[..]} — stop streaming; drop server cursor.
- {"t":"backfill","sid":"..","before":<seq>,"limit":80} — reply one `page`.
- {"t":"pong"} — heartbeat reply.

## Server → Client (JSON, `t`=type; carry `sid` except status/ping)
- {"t":"batch","sid":..,"seq":n,"messages":[..]} — initial backlog.
- {"t":"msg","sid":..,"seq":n,"message":{..}} — one new incremental message.
- {"t":"page","sid":..,"messages":[..],"hasMore":bool} — backfill reply.
- {"t":"status","rows":[..]} — merged live-status (replaces /api/live/status); all live
  sessions, throttled <=1/sec, regardless of subscription set.
- {"t":"artifact","sid":..,..} — port existing artifactOne events.
- {"t":"error","sid":..,"message":..} — non-fatal per-sid error.
- {"t":"ping"} — every 25s; close if no traffic 60s.

Per-socket state: subscribed sids + per-sid monotonic seq/cursor so re-subscribe after
reconnect resumes without dupes.

## Reuse, do not reinvent
Reuse the EXISTING backlog + incremental pump from `/api/live/stream` (indexedMessagePage as
the only backlog/page read model, same server-side render). Do NOT change the message
payload shape — the frontend renders the same objects it does today. One shared
file-watch/poll loop per sid, ref-counted across sockets; stop when the last subscriber
leaves.

## Instrumentation (existing evlog() helper)
Server: ws_connect, ws_subscribe (durationMs to first batch), ws_backlog (readMs/renderMs/
totalMs), ws_msg_pump. Client: ws_client_open, ws_client_first_msg (elapsedMs), ws_client_reconnect.

## Rollout / safety
Gate the ENTIRE path (server + client) behind env flag LIVE_TRANSPORT (default "sse"); WS
active only when LIVE_TRANSPORT=ws. Existing SSE endpoints + useLiveSessionStream stay fully
intact when flag=sse — additive, zero regressions. No DB/schema changes.

## Definition of done
One socket/client; expand/collapse/switch sends deltas with zero reconnects (evlog: no
ws_client_reconnect on id-set change). E2E warm-load ws_client_first_msg p50 < 1000ms locally.
Old SSE still works with flag=sse. Typecheck + build clean.
