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
//   either → other    {type:"ping"} / {type:"pong"}
//
// This is intentionally the smallest surface that lets a relay reverse-proxy
// HTTP semantics (incl. serve.ts's SSE/WS endpoints, tunneled as ordinary
// request/response framing) onto a box with no inbound port open. An `error`
// frame during `hello` means the saved token is no longer valid (expired,
// revoked, or unknown to the relay) — that will never resolve by retrying,
// so the reconnect loop below treats it as fatal rather than backing off
// forever against a token that can't work.

const HELP = `lfg connect — pair this box to a remote-access relay (EXPERIMENTAL)

Usage:
  lfg connect <code>       Redeem a one-time pairing code from a relay, then stay connected
  lfg connect              Resume the saved binding, if any (safe to re-invoke, e.g. from a
                           process manager after a restart); shows this help if never paired
  lfg connect status       Show the current relay binding, if any
  lfg connect disconnect   Drop the saved binding and stop
  lfg connect help         Show this help

Env:
  LFG_RELAY_URL       Relay WebSocket URL (required — no default, this file is provider-agnostic)
  LFG_PORT / LFG_HOST Local 'lfg serve' address to proxy requests to (default 127.0.0.1:8766)

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

  let backoffMs = RECONNECT_MIN_MS;
  for (;;) {
    try {
      console.log(`lfg connect: dialing ${creds.relayUrl} as ${creds.boxId} …`);
      const ws = await connectSocket(creds.relayUrl, { type: "hello", token: creds.token });
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
