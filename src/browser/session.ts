// Live interactive browser-login sessions. A human drives a real headed-capable
// Chromium page through the browser UI: we stream the page as JPEG frames over a
// websocket (via CDP Page.startScreencast) and forward the human's mouse/keyboard
// back into the page (via CDP Input.dispatch*). When they're logged in they hit
// "save", and we snapshot the Playwright storageState into a reusable profile
// (see ./profiles.ts) that an agent's headless browser can later replay.
//
// The websocket itself is abstracted behind WSLike so this module doesn't depend
// on Bun's ServerWebSocket — serve.ts adapts its socket to this shape.
import { loadChromium } from "../native-deps.ts";
import {
  newProfileId,
  profileStatePath,
  saveProfileState,
} from "./profiles.ts";

export type LoginSession = { id: string };

// Viewport the human's login browser renders at. The client picks this (match
// my screen / desktop / mobile) so the login page lays out the way they expect;
// agents later replay the saved cookies in their own headless viewport.
export type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
};

const DEFAULT_VIEWPORT: Required<Viewport> = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
};

// Convincing mobile UA so responsive sites serve their phone layout when the
// "mobile" preset is chosen (viewport width + isMobile alone isn't always enough).
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Clamp client-supplied dimensions into sane bounds; fall back to the desktop
// default when anything is missing or non-numeric.
function sanitizeViewport(v?: Partial<Viewport> | null): Required<Viewport> {
  if (!v || typeof v.width !== "number" || typeof v.height !== "number") {
    return DEFAULT_VIEWPORT;
  }
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, Math.round(n)));
  return {
    width: clamp(v.width, 320, 3840),
    height: clamp(v.height, 320, 2160),
    deviceScaleFactor:
      typeof v.deviceScaleFactor === "number"
        ? clamp(v.deviceScaleFactor, 1, 3)
        : 1,
    isMobile: !!v.isMobile,
  };
}

// Minimal transport contract serve.ts adapts a Bun ServerWebSocket to.
export type WSLike = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
};

// In-memory live sessions. Deliberately not persisted: a session is a running
// browser process and dies with the server.
type LiveSession = {
  id: string;
  browser: import("playwright").Browser;
  context: import("playwright").BrowserContext;
  page: import("playwright").Page;
  viewport: Required<Viewport>;
};

const sessions = new Map<string, LiveSession>();

// Best-effort origin extraction from a page URL (scheme://host[:port]).
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Launch a Chromium context (replaying an existing profile's storageState when
// asked), navigate to `url`, and register it under a fresh id.
export async function startLoginSession(
  url: string,
  opts?: { existingProfileId?: string; viewport?: Partial<Viewport> | null },
): Promise<{ id: string }> {
  const id = newProfileId();
  const viewport = sanitizeViewport(opts?.viewport);
  // Meta (Threads/Instagram) blocks *headless* Chromium on login — the page
  // renders but the credential POST silently fails ("Something went wrong").
  // Run headed when an X display is available (Xvfb :99 in prod, see
  // lfg-xvfb.service); fall back to headless if there's no DISPLAY so dev boxes
  // without a display still work. `--disable-blink-features=AutomationControlled`
  // drops the `--enable-automation` fingerprint Meta keys on.
  const headed = !!process.env.DISPLAY;
  const chromium = await loadChromium();
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    ...(opts?.existingProfileId
      ? { storageState: profileStatePath(opts.existingProfileId) }
      : {}),
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    ...(viewport.isMobile ? { userAgent: MOBILE_UA } : {}),
  });
  // Mask the residual automation tell: Playwright leaves navigator.webdriver
  // === true even headed, which Meta reads as a bot. Hide it before any page
  // script runs. Applies to every page opened in this context.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  // DIAGNOSTIC: log Meta's actual login responses so we can tell a bot/IP
  // checkpoint ("something went wrong") apart from bad creds. Remove once the
  // Threads login issue is resolved.
  page.on("response", (resp) => {
    const u = resp.url();
    if (!/accounts\/login|bloks|challenge|checkpoint|two_factor|web\/accounts/i.test(u))
      return;
    void resp
      .text()
      .then((body) => {
        console.log(
          `[login-diag ${id}] ${resp.status()} ${u.slice(0, 110)} :: ${body
            .replace(/\s+/g, " ")
            .slice(0, 500)}`,
        );
      })
      .catch(() => {
        console.log(`[login-diag ${id}] ${resp.status()} ${u.slice(0, 110)} :: <no body>`);
      });
  });
  sessions.set(id, { id, browser, context, page, viewport });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } catch {
    // Navigation failures are non-fatal — the human can retry via {type:'navigate'}.
  }
  return { id };
}

// Wire a websocket to a running session: stream frames out, pump input in.
export function attachStream(sessionId: string, ws: WSLike): void {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "unknown session" }));
    ws.close();
    return;
  }
  const { context, page } = session;

  // CDP session is created lazily inside an async IIFE so attachStream stays sync.
  let cdp: import("playwright").CDPSession | null = null;
  let stopped = false;

  const sendError = (message: string) => {
    try {
      ws.send(JSON.stringify({ type: "error", message }));
    } catch {
      // socket already gone
    }
  };

  const sendStatus = async (state: "loading" | "ready" | "closed") => {
    let title = "";
    let url = "";
    try {
      url = page.url();
      title = await page.title();
    } catch {
      // page may be navigating/closed
    }
    try {
      ws.send(JSON.stringify({ type: "status", state, url, title }));
    } catch {
      // socket already gone
    }
  };

  const stopScreencast = async () => {
    if (stopped) return;
    stopped = true;
    try {
      if (cdp) await cdp.send("Page.stopScreencast");
    } catch {
      // CDP may already be detached
    }
  };

  (async () => {
    try {
      cdp = await context.newCDPSession(page);

      // Frame pump: re-emit each JPEG to the client, then ack so CDP keeps going.
      cdp.on("Page.screencastFrame", async (frame) => {
        try {
          ws.send(
            JSON.stringify({
              type: "frame",
              dataB64: frame.data,
              w: frame.metadata.deviceWidth,
              h: frame.metadata.deviceHeight,
            }),
          );
        } catch {
          // socket gone — stop streaming
          await stopScreencast();
          return;
        }
        try {
          await cdp!.send("Page.screencastFrameAck", {
            sessionId: frame.sessionId,
          });
        } catch {
          // frame already invalid / cdp detached
        }
      });

      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        everyNthFrame: 1,
        // Stream at the chosen viewport (in device px) so frames aren't capped
        // or downscaled by CDP's defaults.
        maxWidth: Math.round(
          session.viewport.width * session.viewport.deviceScaleFactor,
        ),
        maxHeight: Math.round(
          session.viewport.height * session.viewport.deviceScaleFactor,
        ),
      });

      // Reflect navigations as status updates so the client can show the URL bar.
      page.on("load", () => void sendStatus("ready"));
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame()) void sendStatus("loading");
      });

      await sendStatus("ready");
    } catch (e) {
      sendError((e as Error).message);
    }
  })();

  // ---- client -> server ----
  ws.onMessage((data) => {
    void (async () => {
      let msg: any;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      try {
        if (!cdp) return;
        switch (msg.type) {
          case "input":
            await handleInput(cdp, msg);
            break;
          case "navigate":
            if (typeof msg.url === "string") {
              await page.goto(msg.url, { waitUntil: "domcontentloaded" });
              await sendStatus("ready");
            }
            break;
          case "reload":
            await page.reload({ waitUntil: "domcontentloaded" });
            await sendStatus("ready");
            break;
          case "save": {
            const name =
              typeof msg.name === "string" && msg.name.trim()
                ? msg.name.trim()
                : "Saved login";
            const state = await context.storageState();
            // Collect origins from the captured state plus the live page URL.
            const origins = new Set<string>();
            for (const o of state.origins ?? []) {
              if (o.origin) origins.add(o.origin);
            }
            const live = originOf(page.url());
            if (live) origins.add(live);
            const profileId = newProfileId();
            await saveProfileState(profileId, name, state, [...origins]);
            ws.send(JSON.stringify({ type: "saved", profileId }));
            break;
          }
          default:
            break;
        }
      } catch (e) {
        sendError((e as Error).message);
      }
    })();
  });

  ws.onClose(() => {
    // Closing the viewer stops the stream but leaves the session alive so the
    // human can reconnect. endSession() is the explicit teardown.
    void stopScreencast();
  });
}

// Translate a client input event into the matching CDP Input.* call. Coordinates
// are CSS px of the streamed viewport, which is exactly what CDP expects.
async function handleInput(
  cdp: import("playwright").CDPSession,
  msg: any,
): Promise<void> {
  const x = typeof msg.x === "number" ? msg.x : 0;
  const y = typeof msg.y === "number" ? msg.y : 0;
  const button: "left" | "middle" | "right" =
    msg.button === 2 || msg.button === "right"
      ? "right"
      : msg.button === 1 || msg.button === "middle"
        ? "middle"
        : "left";

  switch (msg.kind) {
    case "mousemove":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      break;
    case "mousedown":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount: 1,
      });
      break;
    case "mouseup":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount: 1,
      });
      break;
    case "wheel":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: typeof msg.deltaY === "number" ? msg.deltaY : 0,
      });
      break;
    case "keydown":
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: typeof msg.key === "string" ? msg.key : "",
      });
      break;
    case "keyup":
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: typeof msg.key === "string" ? msg.key : "",
      });
      break;
    case "char":
      // Text entry: insertText handles IME/composed characters cleanly.
      if (typeof msg.text === "string" && msg.text) {
        await cdp.send("Input.insertText", { text: msg.text });
      }
      break;
    default:
      break;
  }
}

// Explicit teardown: close the browser and forget the session.
export async function endSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    await session.context.close();
  } catch {
    // already closed
  }
  try {
    await session.browser.close();
  } catch {
    // already closed
  }
}
