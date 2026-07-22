import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PATHS } from "../config.ts";

// lfg connect — generic remote-access relay client.
//
// Lets a self-hosted `lfg serve` box be reached through a WebSocket relay
// instead of exposing an inbound port. Deliberately provider-agnostic: this
// file must never hardcode a specific relay's URL, branding, or account
// model — LFG_RELAY_URL is a required argument, not a default, so any
// operator can point it at their own relay implementation. (omg's dashboard
// supplies its own relay URL as the *value* of that env var — see
// apps/imsg/BYO_COMPUTER.md in the vibes repo for that integration; nothing
// omg-specific belongs in this file.)
//
// `lfg serve`'s own HTTP API has no application-layer auth (see
// live-ws.ts's liveWsUpgradeAuthenticated) — it always trusted its network
// perimeter (localhost bind, or whatever put it there). A relay is a new
// perimeter, so this client authenticates to the RELAY (pairing code once,
// then a persisted bearer token) — it does not change `serve` itself.
//
// Wire protocol (JSON frames over one WebSocket to LFG_RELAY_URL):
//   client → relay   {type:"pair", code}                     (first connect only)
//   relay  → client   {type:"paired", token, boxId}           (persist token; reconnect with it instead of a code)
//   client → relay   {type:"hello", token}                    (subsequent connects)
//   relay  → client   {type:"hello-ok"}                        (optional; unknown frame types are ignored anyway)
//   relay  → client   {type:"error", message}                  (pairing/hello rejected — relay closes right after)
//   relay  → client   {type:"http", id, method, path, headers, bodyB64?}
//   client → relay   {type:"http-response", id, status, headers, bodyB64?}
//   client → relay   {type:"event", event, sessionId, title?, project?, agent?, ts}
//                     (opt-in, LFG_CONNECT_EVENTS=1 — see "Session lifecycle
//                     events" below; no response frame, a relay that doesn't
//                     understand `event` just ignores or errors it and this
//                     client doesn't care either way)
//   either → other    {type:"ping"} / {type:"pong"}
//
// This is intentionally the smallest surface that lets a relay reverse-proxy
// HTTP semantics (incl. serve.ts's SSE/WS endpoints, tunneled as ordinary
// request/response framing) onto a box with no inbound port open. An `error`
// frame during `hello` means the saved token is no longer valid (expired,
// revoked, or unknown to the relay) — that will never resolve by retrying,
// so the reconnect loop below treats it as fatal rather than backing off
// forever against a token that can't work.
//
// Session lifecycle events (opt-in, LFG_CONNECT_EVENTS=1):
//
// When enabled, this client also polls its own local `lfg serve` (the same
// GET /api/sessions any client of this box's HTTP API can call — see
// src/sessions.ts's Session type) every LFG_CONNECT_EVENTS_INTERVAL_MS (default
// 4000ms) and diffs busy/status transitions per session. Two transitions are
// reported as `event` frames up the relay socket, whenever a live connection
// is open:
//   - a session that was busy goes idle without being blocked → "session.completed"
//   - a session's status flips to "blocked" (see computeStatus in
//     src/sessions.ts — model unavailable, out of credits, provider auth/error)
//     → "session.needs_attention"
// The very first poll after connecting only seeds a baseline (no events) so a
// box that's had long-finished sessions sitting around doesn't fire a burst of
// stale notifications on startup.
//
// This intentionally polls locally rather than opening a second WebSocket to
// this box's own `/api/live/ws` status channel: `lfg connect` runs as a
// separate process from `lfg serve` (its only access to this box is the same
// HTTP surface a remote client would use), and a plain interval against
// GET /api/sessions is far simpler to reason about and test than a second
// long-lived socket with its own reconnect/heartbeat state machine. The
// resulting latency (bounded by the poll interval, a few seconds at most, and
// entirely on loopback) is negligible next to what it replaces — this box
// announcing a completion is still categorically faster than a remote poller
// checking in every few seconds over the network.
//
// Not every transition is forwarded, even with the flag on — two sanity
// defaults any relay operator gets for free, applied client-side before a
// frame is ever built:
//   - top-level only: a session with a parentSessionId (a subagent, spawned
//     via `lfg subagent` — see src/commands/subagent.ts) never generates a
//     frame. Subagent churn is routine and constant on a box running any
//     nontrivial agent workflow; forwarding it would mean every internal
//     step of someone else's task looks like a top-level notification.
//   - a minimum duration floor (MIN_REPORTABLE_DURATION_MS, default 60s):
//     a session.completed for a session that started and finished inside a
//     minute isn't news — quick blips (a one-line question, a trivial
//     lookup) shouldn't page anyone. session.needs_attention is exempt from
//     this floor: a session going "blocked" is actionable no matter how
//     young it is, unlike routine completion.
// See isTopLevelSession/isReportableTransition below.
//
// PRIVACY NOTE: when enabled, session titles (and project/agent names) leave
// this box and are sent to whatever relay LFG_RELAY_URL points at, which then
// (per that relay's own policy) may forward them further (e.g. omg's relay
// forwards to an operator-configured webhook — see BYO_COMPUTER.md in the
// vibes repo). A session title is derived from your own first prompt in that
// session (see firstPromptTitle in src/sessions.ts) and can contain whatever
// you typed. This is why the flag defaults OFF — turning it on is an explicit
// choice to let a completion/attention signal (and the small amount of
// context needed to make it useful) leave the box. The top-level/60s filter
// above narrows WHICH transitions can trigger that, but doesn't change what
// leaves the box once one does.

const HELP = `lfg connect — pair this box to a remote-access relay (EXPERIMENTAL)

Usage:
  lfg connect <code>       Redeem a one-time pairing code from a relay, then stay connected
  lfg connect              Resume the saved binding, if any (safe to re-invoke, e.g. from a
                           process manager after a restart); shows this help if never paired
  lfg connect status       Show the current relay binding, if any
  lfg connect disconnect   Drop the saved binding and stop
  lfg connect help         Show this help

Env:
  LFG_RELAY_URL              Relay WebSocket URL (required — no default, this file is provider-agnostic)
  LFG_PORT / LFG_HOST        Local 'lfg serve' address to proxy requests to (default 127.0.0.1:8766)
  LFG_CONNECT_EVENTS         Opt-in (1/true/yes, default off): forward session completed/needs-attention
                             events AND shipped-post events to the relay. PRIVACY: session titles and
                             ship titles/summaries leave this box when on.
  LFG_CONNECT_EVENTS_INTERVAL_MS  Local session-poll interval in ms when events are enabled (default 4000)
  LFG_CONNECT_EVENTS_MIN_DURATION_MS  Minimum session duration to report a completion, in ms (default 60000).
                             Does not apply to session.needs_attention (always reported).

No relay implementation ships with LFG. This is the generic client half of a
protocol any relay operator can implement — see the wire protocol documented
at the top of src/commands/connect.ts.
`;

const CREDENTIALS_PATH = join(PATHS.data, "relay-credentials.json");
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const LOCAL_PORT = Number(process.env.LFG_PORT ?? process.env.PORT ?? 8766);
const LOCAL_HOST = process.env.LFG_HOST ?? "127.0.0.1";

interface RelayCredentials {
  relayUrl: string;
  token: string;
  boxId: string;
  pairedAt: number;
}

async function readCredentials(): Promise<RelayCredentials | null> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as RelayCredentials;
  } catch {
    return null;
  }
}

async function writeCredentials(creds: RelayCredentials): Promise<void> {
  await mkdir(PATHS.data, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function requireRelayUrl(): string {
  const url = process.env.LFG_RELAY_URL?.trim();
  if (!url) {
    console.error("lfg connect: LFG_RELAY_URL is not set — point it at your relay's WebSocket URL.\n");
    console.log(HELP);
    process.exit(1);
  }
  return url;
}

type HttpFrame = {
  type: "http";
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyB64?: string;
};

export function isHttpFrame(value: unknown): value is HttpFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "http" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { method?: unknown }).method === "string" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

export function errorFrameMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if ((value as { type?: unknown }).type !== "error") return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message ? message : "the relay rejected this connection";
}

/** A `{type:"error"}` frame the relay sent for `hello` — the saved token is
 * dead (expired/revoked/unknown); re-pairing is the only fix, so the
 * reconnect loop treats this as fatal rather than backing off forever. */
class RelayAuthError extends Error {}

/** Proxies one relayed HTTP request onto this box's own `lfg serve`. */
export async function forwardToLocalServe(frame: HttpFrame): Promise<{
  type: "http-response";
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}> {
  try {
    const response = await fetch(`http://${LOCAL_HOST}:${LOCAL_PORT}${frame.path}`, {
      method: frame.method,
      headers: frame.headers,
      body: frame.bodyB64 ? Buffer.from(frame.bodyB64, "base64") : undefined,
    });
    const bodyB64 = Buffer.from(await response.arrayBuffer()).toString("base64");
    return {
      type: "http-response",
      id: frame.id,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      bodyB64,
    };
  } catch (error) {
    return {
      type: "http-response",
      id: frame.id,
      status: 502,
      headers: { "content-type": "text/plain" },
      bodyB64: Buffer.from(`lfg connect: local serve unreachable — ${String(error)}`).toString("base64"),
    };
  }
}

// ---- Session lifecycle events (opt-in) — see the doc block above. ----

function eventsEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LFG_CONNECT_EVENTS?.trim() ?? "");
}

const EVENTS_POLL_MS = Number(process.env.LFG_CONNECT_EVENTS_INTERVAL_MS ?? 4_000);
const MIN_REPORTABLE_DURATION_MS = Number(process.env.LFG_CONNECT_EVENTS_MIN_DURATION_MS ?? 60_000);

/** The subset of src/sessions.ts's `Session` this client reads off GET /api/sessions. */
export type SessionLite = {
  sessionId: string | null;
  busy?: boolean;
  launching?: boolean;
  status?: "ok" | "blocked";
  title?: string | null;
  project?: string | null;
  agent?: string | null;
  // Present (non-null) only for a subagent (see src/commands/subagent.ts) —
  // absence/null means top-level. This is the only signal isTopLevelSession
  // needs; subagentDepth is not part of this HTTP payload today, but a
  // future depth > 0 would mean the same thing and isTopLevelSession is
  // written to treat it identically if it ever shows up here.
  parentSessionId?: string | null;
  subagentDepth?: number | null;
  // Session.startedAt off GET /api/sessions — when the session was
  // launched. Used for the reportable-duration floor below.
  startedAt?: number | null;
};

type SeenSession = { busy: boolean; status: "ok" | "blocked" };

/** No parentSessionId and no positive subagentDepth — see the doc block at
 * the top of this file for why subagent churn never leaves the box. */
export function isTopLevelSession(session: SessionLite): boolean {
  return !session.parentSessionId && !session.subagentDepth;
}

/**
 * Whether this tick's transition is worth forwarding at all, independent of
 * title hygiene (the gateway's job — see BYO_COMPUTER.md). needs_attention
 * is exempt from the duration floor: a blocked session is actionable
 * regardless of age. A session.completed with no startedAt to judge against
 * is let through rather than silently dropped — an unknown duration isn't
 * evidence the run was a quick blip.
 */
export function isReportableTransition(
  event: SessionEventFrame["event"],
  session: SessionLite,
  ts: number,
): boolean {
  if (!isTopLevelSession(session)) return false;
  if (event === "session.needs_attention") return true;
  const startedAt = session.startedAt ?? null;
  if (startedAt == null) return true;
  return ts - startedAt >= MIN_REPORTABLE_DURATION_MS;
}

export type SessionEventFrame = {
  type: "event";
  event: "session.completed" | "session.needs_attention";
  sessionId: string;
  title: string | null;
  project: string | null;
  agent: string | null;
  ts: number;
};

/** A shipped-post announcement (POST /api/shipped → shipped.jsonl). Same
 * envelope as SessionEventFrame so relays that already tolerate `event`
 * frames forward it unchanged; `summary` is the extra, ship-specific field. */
export type ShipEventFrame = {
  type: "event";
  event: "ship.posted";
  sessionId: string;
  title: string | null;
  project: string | null;
  agent: string | null;
  summary: string | null;
  ts: number;
};

function makeEventFrame(event: SessionEventFrame["event"], session: SessionLite, ts: number): SessionEventFrame {
  return {
    type: "event",
    event,
    sessionId: session.sessionId as string,
    title: session.title ?? null,
    project: session.project ?? null,
    agent: session.agent ?? null,
    ts,
  };
}

/**
 * Diffs one poll's session list against the previously-seen state (mutated in
 * place — `seen` is the caller's running baseline across ticks) and returns
 * the lifecycle events this tick produced. Pure/sync so it's cheaply testable
 * without a fake server or a fake clock beyond an injected `ts`.
 *
 * A session absent from `seen` (first time observed) never emits — it only
 * seeds the baseline, so restarting `lfg connect` against a box with
 * already-finished sessions doesn't fire a burst of stale notifications.
 * A transition that fails isReportableTransition (not top-level, or a
 * completion under the duration floor) is diffed the same as any other —
 * `seen` is still updated — it just never becomes an event.
 */
export function diffSessionEvents(seen: Map<string, SeenSession>, sessions: SessionLite[], ts: number): SessionEventFrame[] {
  const events: SessionEventFrame[] = [];
  const presentIds = new Set<string>();
  for (const session of sessions) {
    if (!session.sessionId) continue;
    presentIds.add(session.sessionId);
    const busy = Boolean(session.busy);
    const status = session.status ?? "ok";
    const prior = seen.get(session.sessionId);
    if (prior) {
      if (prior.status !== "blocked" && status === "blocked") {
        if (isReportableTransition("session.needs_attention", session, ts)) {
          events.push(makeEventFrame("session.needs_attention", session, ts));
        }
      } else if (prior.busy && !busy && !session.launching && status === "ok") {
        if (isReportableTransition("session.completed", session, ts)) {
          events.push(makeEventFrame("session.completed", session, ts));
        }
      }
    }
    seen.set(session.sessionId, { busy, status });
  }
  // Drop sessions no longer listed so a later reappearance (id reuse, or the
  // session coming back after a transient list gap) re-baselines instead of
  // comparing against stale state.
  for (const sessionId of seen.keys()) {
    if (!presentIds.has(sessionId)) seen.delete(sessionId);
  }
  return events;
}

/** The subset of a hydrated ship post this client reads off GET /api/shipped. */
export type ShipPostLite = {
  id: string;
  rev: number;
  ts: number;
  title: string;
  summary?: string | null;
  sessionId?: string | null;
  project?: string | null;
  agent?: string | null;
};

/**
 * Diffs one poll's ship feed against the previously-seen `id → rev` baseline
 * (mutated in place, same contract as diffSessionEvents). First observation
 * of an id only seeds the baseline — restarting `lfg connect` never replays
 * the whole shipped feed as notifications. A higher rev on a known id IS
 * forwarded (a re-ship is a deliberate update to the showcase).
 */
export function diffShipEvents(seenShips: Map<string, number>, posts: ShipPostLite[], firstPoll: boolean): ShipEventFrame[] {
  const events: ShipEventFrame[] = [];
  for (const post of posts) {
    if (!post.id) continue;
    const prior = seenShips.get(post.id);
    if (!firstPoll && (prior === undefined || post.rev > prior)) {
      events.push({
        type: "event",
        event: "ship.posted",
        // Relays require a session-shaped id on every event frame; a ship
        // posted without one still needs a stable, unique value.
        sessionId: post.sessionId?.trim() || `ship:${post.id}`,
        title: post.title ?? null,
        project: post.project ?? null,
        agent: post.agent ?? null,
        summary: post.summary ?? null,
        ts: post.ts ?? Date.now(),
      });
    }
    seenShips.set(post.id, post.rev);
  }
  return events;
}

async function pollShipEvents(
  state: { seenShips: Map<string, number>; seeded: boolean },
  getSocket: () => WebSocket | null,
): Promise<void> {
  let posts: ShipPostLite[];
  try {
    const response = await fetch(`http://${LOCAL_HOST}:${LOCAL_PORT}/api/shipped`);
    if (!response.ok) return;
    const body = (await response.json()) as { posts?: ShipPostLite[] };
    posts = body.posts ?? [];
  } catch {
    return; // local serve unreachable this tick — try again next tick.
  }
  const events = diffShipEvents(state.seenShips, posts, !state.seeded);
  state.seeded = true;
  if (!events.length) return;
  const ws = getSocket();
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // best-effort, same as sessions.
  for (const frame of events) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort — see pollSessionEvents.
    }
  }
}

async function pollSessionEvents(seen: Map<string, SeenSession>, getSocket: () => WebSocket | null): Promise<void> {
  let sessions: SessionLite[];
  try {
    const response = await fetch(`http://${LOCAL_HOST}:${LOCAL_PORT}/api/sessions`);
    if (!response.ok) return;
    const body = (await response.json()) as { sessions?: SessionLite[] };
    sessions = body.sessions ?? [];
  } catch {
    return; // local serve unreachable this tick — try again next tick.
  }
  const events = diffSessionEvents(seen, sessions, Date.now());
  if (!events.length) return;
  const ws = getSocket();
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // no live relay connection right now — drop this tick's events.
  for (const frame of events) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort — a dead socket or a relay that rejects `event` frames
      // just loses this one notification, never the connection itself.
    }
  }
}

function connectSocket(relayUrl: string, hello: { type: "pair"; code: string } | { type: "hello"; token: string }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(hello));
      resolve(ws);
    });
    ws.addEventListener("error", (event) => reject(new Error(`relay connection failed: ${String(event)}`)));
  });
}

/** Redeems a one-time pairing code, persists the returned token, then falls through to the persistent connect loop. */
async function pair(code: string): Promise<void> {
  const relayUrl = requireRelayUrl();
  console.log(`lfg connect: redeeming pairing code against ${relayUrl} …`);
  const ws = await connectSocket(relayUrl, { type: "pair", code });

  const paired = await new Promise<{ token: string; boxId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for relay to confirm pairing")), 15_000);
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as { type?: string; token?: string; boxId?: string };
        if (msg.type === "paired" && msg.token && msg.boxId) {
          clearTimeout(timeout);
          resolve({ token: msg.token, boxId: msg.boxId });
          return;
        }
        const errorMessage = errorFrameMessage(msg);
        if (errorMessage) {
          clearTimeout(timeout);
          reject(new Error(errorMessage));
        }
      } catch {
        // ignore malformed frames while waiting for the pairing ack
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      reject(new Error("relay closed the connection before confirming pairing"));
    });
  });

  await writeCredentials({ relayUrl, token: paired.token, boxId: paired.boxId, pairedAt: Date.now() });
  console.log(`lfg connect: paired as ${paired.boxId} — credentials saved to ${CREDENTIALS_PATH}`);
  ws.close();
  await runConnectLoop();
}

/** Long-running: reconnects with backoff and proxies relayed HTTP frames onto local serve, forever. */
async function runConnectLoop(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    console.error("lfg connect: no saved binding — run `lfg connect <code>` first.");
    process.exit(1);
  }

  // Session-events watcher lives for the whole process, independent of any
  // one relay connection: it always polls local serve, and only SENDS a
  // frame when `currentWs` happens to be open at the moment a transition is
  // detected (see pollSessionEvents — otherwise it just drops that tick's
  // events, same "best-effort, poller elsewhere is the fallback" posture as
  // everything else in this file).
  let currentWs: WebSocket | null = null;
  if (eventsEnabled()) {
    console.log(
      `lfg connect: forwarding session lifecycle events to the relay every ${EVENTS_POLL_MS}ms (LFG_CONNECT_EVENTS=1) — session titles will be sent to the relay.`,
    );
    const seen = new Map<string, SeenSession>();
    const timer = setInterval(() => void pollSessionEvents(seen, () => currentWs), EVENTS_POLL_MS);
    timer.unref?.();
    // Shipped-post watcher — same opt-in, same cadence, same best-effort
    // posture. A ship (lfg_ship / POST /api/shipped) is an explicit showcase,
    // so it's forwarded as its own `ship.posted` frame with the summary.
    const shipState = { seenShips: new Map<string, number>(), seeded: false };
    const shipTimer = setInterval(() => void pollShipEvents(shipState, () => currentWs), EVENTS_POLL_MS);
    shipTimer.unref?.();
  }

  let backoffMs = RECONNECT_MIN_MS;
  for (;;) {
    try {
      console.log(`lfg connect: dialing ${creds.relayUrl} as ${creds.boxId} …`);
      const ws = await connectSocket(creds.relayUrl, { type: "hello", token: creds.token });
      currentWs = ws;
      backoffMs = RECONNECT_MIN_MS;
      console.log(`lfg connect: connected — proxying to local serve on ${LOCAL_HOST}:${LOCAL_PORT}`);

      let authRejected: string | null = null;
      await new Promise<void>((resolveClosed) => {
        ws.addEventListener("message", (event) => {
          void (async () => {
            let frame: unknown;
            try {
              frame = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (frame && typeof frame === "object" && (frame as { type?: unknown }).type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
              return;
            }
            const errorMessage = errorFrameMessage(frame);
            if (errorMessage) {
              authRejected = errorMessage;
              ws.close();
              return;
            }
            if (isHttpFrame(frame)) ws.send(JSON.stringify(await forwardToLocalServe(frame)));
          })();
        });
        ws.addEventListener("close", () => resolveClosed());
        ws.addEventListener("error", () => resolveClosed());
      });
      currentWs = null;
      if (authRejected) throw new RelayAuthError(authRejected);
      console.log("lfg connect: relay connection closed — reconnecting");
    } catch (error) {
      if (error instanceof RelayAuthError) {
        console.error(`lfg connect: ${error.message}`);
        console.error("lfg connect: run `lfg connect <code>` with a fresh pairing code to reconnect.");
        process.exit(1);
      }
      console.error(`lfg connect: ${String(error)}`);
    }
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(RECONNECT_MAX_MS, backoffMs * 2);
  }
}

async function printStatus(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    console.log("lfg connect: not paired with any relay.");
    return;
  }
  console.log(`lfg connect: paired as ${creds.boxId} via ${creds.relayUrl} (since ${new Date(creds.pairedAt).toISOString()})`);
}

async function disconnect(): Promise<void> {
  const creds = await readCredentials();
  if (!creds) {
    console.log("lfg connect: nothing to disconnect.");
    return;
  }
  await rm(CREDENTIALS_PATH, { force: true });
  console.log(`lfg connect: cleared local binding to ${creds.relayUrl}. (The relay may still hold a stale token until it expires — this command only clears this box's side.)`);
}

export async function cmdConnect(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "status":
      return printStatus();
    case "disconnect":
      return disconnect();
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    case undefined: {
      // A process manager (systemd `Restart=always`, etc.) re-invokes `lfg
      // connect` with no arguments on every restart — it doesn't have a fresh
      // pairing code to hand it, and shouldn't need one: the saved token is
      // still good. Resume the connect loop from it; only fall back to HELP
      // when there's genuinely nothing paired yet.
      const creds = await readCredentials();
      if (creds) return runConnectLoop();
      console.log(HELP);
      return;
    }
    default:
      if (rest.length > 0 || sub.startsWith("-")) {
        console.error(`Unknown connect subcommand: ${sub}\n`);
        console.log(HELP);
        process.exit(1);
      }
      // Anything else is treated as a pairing code.
      return pair(sub);
  }
}
