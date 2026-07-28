import { describe, expect, test } from "bun:test";
import {
  type ConnectAgentInfo,
  embeddedConnectOptions,
  hasConnectedGateProvider,
  shouldShowEmbeddedConnectGate,
} from "../web/src/lib/embedded-connect.ts";
import {
  LFG_SESSION_CREATED_MESSAGE,
  originOf,
  postSessionCreatedToHost,
  resolveHostOrigin,
  sessionCreatedMessage,
} from "../web/src/lib/embed-host-signal.ts";

function agent(
  key: string,
  opts: { installed?: boolean; authed?: boolean; canAutoSetup?: boolean } = {},
): ConnectAgentInfo {
  const installed = opts.installed !== false;
  const authed = opts.authed === true;
  const label = key === "codex" ? "Codex" : "Claude";
  return {
    key,
    label,
    status: {
      configured: installed && authed,
      canAutoSetup: opts.canAutoSetup !== false,
      checks: [
        { label: `${label} CLI`, ok: installed },
        { label: `${label} auth`, ok: authed },
      ],
    },
  };
}

const FRESH_BOX = [agent("claude"), agent("codex")];

describe("embedded connect gate visibility", () => {
  test("opens on a framed box with nothing authenticated", () => {
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: FRESH_BOX })).toBe(true);
  });

  test("never opens outside embed mode (standalone keeps onboarding)", () => {
    expect(shouldShowEmbeddedConnectGate({ embedded: false, agents: FRESH_BOX })).toBe(false);
  });

  test("closes the moment Claude connects", () => {
    const connected = [agent("claude", { authed: true }), agent("codex")];
    expect(hasConnectedGateProvider(connected)).toBe(true);
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: connected })).toBe(false);
  });

  test("closes when Codex connects", () => {
    const connected = [agent("claude"), agent("codex", { authed: true })];
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: connected })).toBe(false);
  });

  test("a login reported only on the ai-sdk sibling also closes it", () => {
    // `claude auth login` configures both the CLI kind and aisdk; either
    // reporting configured means the provider is connected.
    const connected = [agent("claude"), agent("aisdk", { authed: true }), agent("codex")];
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: connected })).toBe(false);
  });

  test("bundled pi / OpenCode must NOT satisfy the gate on a fresh image", () => {
    // agent-lfg ships pi bundled (file-based auth) and can carry OpenCode or
    // Copilot creds in the image. Those report configured while the user still
    // has no Claude/Codex login, so the connect prompt must stay up.
    const imageDefaults = [
      ...FRESH_BOX,
      agent("pi", { authed: true }),
      agent("opencode", { authed: true }),
      agent("copilot", { authed: true }),
    ];
    expect(hasConnectedGateProvider(imageDefaults)).toBe(false);
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: imageDefaults })).toBe(true);
    // …and it closes only once one of the two offered providers connects.
    expect(
      shouldShowEmbeddedConnectGate({
        embedded: true,
        agents: [...imageDefaults.slice(2), agent("claude", { authed: true }), agent("codex")],
      }),
    ).toBe(false);
    // Someone deliberately using pi/OpenCode takes the skip link.
    expect(
      shouldShowEmbeddedConnectGate({ embedded: true, agents: imageDefaults, dismissed: true }),
    ).toBe(false);
  });

  test("an empty roster (bootstrap failed) does not trap the user", () => {
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: [] })).toBe(false);
  });

  test("skipping hides it for this app load", () => {
    expect(
      shouldShowEmbeddedConnectGate({ embedded: true, agents: FRESH_BOX, dismissed: true }),
    ).toBe(false);
  });
});

describe("embedded connect options", () => {
  test("offers exactly Claude Code and Codex, in order", () => {
    const options = embeddedConnectOptions(FRESH_BOX);
    expect(options.map((o) => o.kind)).toEqual(["claude", "codex"]);
    expect(options.map((o) => o.label)).toEqual(["Claude Code", "Codex"]);
    expect(options.map((o) => o.provider)).toEqual(["claude", "codex"]);
  });

  test("reports a missing CLI separately from a missing login", () => {
    const options = embeddedConnectOptions([
      agent("claude", { installed: false }),
      agent("codex", { installed: true, authed: false }),
    ]);
    expect(options[0]).toMatchObject({ installed: false, configured: false });
    expect(options[1]).toMatchObject({ installed: true, configured: false });
  });

  test("carries canAutoSetup so an uninstallable CLI is not offered as a click", () => {
    const options = embeddedConnectOptions([
      agent("claude", { installed: false, canAutoSetup: false }),
    ]);
    expect(options[0]?.canAutoSetup).toBe(false);
  });

  test("skips providers the server does not list", () => {
    expect(embeddedConnectOptions([agent("codex")]).map((o) => o.kind)).toEqual(["codex"]);
    expect(embeddedConnectOptions([])).toEqual([]);
  });
});

describe("host session-created signal", () => {
  test("payload is the tagged message plus the session id, nothing else", () => {
    expect(sessionCreatedMessage("s1")).toEqual({
      type: "lfg:session-created",
      sessionId: "s1",
    });
    expect(LFG_SESSION_CREATED_MESSAGE).toBe("lfg:session-created");
  });

  test("originOf keeps http(s) origins and rejects everything else", () => {
    expect(originOf("https://sessions.omgs.app/computer/1?x=2")).toBe("https://sessions.omgs.app");
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  test("explicit embedOrigin wins over the referrer; referrer is the fallback", () => {
    expect(
      resolveHostOrigin({
        search: "?embed=1&embedOrigin=https%3A%2F%2Fsessions.omgs.app",
        referrer: "https://evil.example/",
      }),
    ).toBe("https://sessions.omgs.app");
    expect(
      resolveHostOrigin({ search: "?embed=1", referrer: "https://sessions.omgs.app/c/9" }),
    ).toBe("https://sessions.omgs.app");
    expect(resolveHostOrigin({ search: "?embed=1", referrer: "" })).toBeNull();
    expect(resolveHostOrigin({ search: null, referrer: null })).toBeNull();
  });

  test("a same-origin referrer is our own navigation, not the host", () => {
    // The router rewrites ?embed=1 to ?embed=true with a real frame
    // navigation; after it the referrer is LFG's own previous URL.
    expect(
      resolveHostOrigin({
        search: "?embed=true",
        referrer: "https://box.lfg.dev/?embed=1",
        selfOrigin: "https://box.lfg.dev",
      }),
    ).toBeNull();
  });

  test("the cached origin survives that rewrite navigation", () => {
    expect(
      resolveHostOrigin({
        search: "?embed=true",
        referrer: "https://box.lfg.dev/?embed=1",
        selfOrigin: "https://box.lfg.dev",
        cached: "https://sessions.omgs.app",
      }),
    ).toBe("https://sessions.omgs.app");
    // A live cross-origin referrer still wins over the cache.
    expect(
      resolveHostOrigin({
        search: "",
        referrer: "https://sessions.omgs.app/c/9",
        selfOrigin: "https://box.lfg.dev",
        cached: "https://stale.example",
      }),
    ).toBe("https://sessions.omgs.app");
    // Garbage in the cache is ignored rather than posted to.
    expect(
      resolveHostOrigin({ search: "", referrer: "", cached: "not a url" }),
    ).toBeNull();
  });

  function recorder() {
    const sent: { message: unknown; origin: string }[] = [];
    return {
      sent,
      target: {
        postMessage: (message: unknown, origin: string) => {
          sent.push({ message, origin });
        },
      },
    };
  }

  test("posts once to the resolved host origin, never to '*'", () => {
    const { sent, target } = recorder();
    const posted = postSessionCreatedToHost("sess-1", {
      embedded: true,
      parent: target,
      self: {},
      origin: "https://sessions.omgs.app",
    });
    expect(posted).toBe(true);
    expect(sent).toEqual([
      {
        message: { type: "lfg:session-created", sessionId: "sess-1" },
        origin: "https://sessions.omgs.app",
      },
    ]);
  });

  test("stays silent when not embedded, unframed, id-less, or origin-less", () => {
    const { sent, target } = recorder();
    const base = { parent: target, self: {}, origin: "https://sessions.omgs.app" };
    expect(postSessionCreatedToHost("s", { ...base, embedded: false })).toBe(false);
    expect(postSessionCreatedToHost("", { ...base, embedded: true })).toBe(false);
    expect(postSessionCreatedToHost("s", { ...base, embedded: true, origin: null })).toBe(false);
    expect(postSessionCreatedToHost("s", { ...base, embedded: true, parent: null })).toBe(false);
    // Top-level window: parent === self, so there is no host to notify.
    expect(
      postSessionCreatedToHost("s", { embedded: true, parent: target, self: target, origin: "https://x.dev" }),
    ).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a throwing host frame degrades to a no-op", () => {
    const posted = postSessionCreatedToHost("s", {
      embedded: true,
      parent: {
        postMessage: () => {
          throw new Error("cross-origin");
        },
      },
      self: {},
      origin: "https://sessions.omgs.app",
    });
    expect(posted).toBe(false);
  });
});

describe("App wiring", () => {
  const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;

  test("the gate renders the shared auth dialog rather than a second auth path", () => {
    const gate = app.slice(app.indexOf("if (connectGateOpen) {"));
    expect(gate).toContain("<EmbeddedConnectGate");
    expect(gate.slice(0, gate.indexOf("</>")))
      .toContain("<CodingAgentAuthDialog");
    // Login/install go through the existing App handlers, not a new fetch.
    expect(gate.slice(0, gate.indexOf("</>"))).toContain("loginCodingAgent(kind as AgentKind)");
    expect(gate.slice(0, gate.indexOf("</>"))).toContain("setupCodingAgent(kind as AgentKind)");
  });

  test("the host signal hangs off the single created-session funnel", () => {
    const funnel = app.slice(
      app.indexOf("function markCreatedSid("),
      app.indexOf("function markCreatedSid(") + 700,
    );
    expect(funnel).toContain("emitSessionCreatedToHost(sid, readLocationEmbedFlag())");
    // Exactly one emit site — not one per /api/sessions/new call site.
    expect(app.split("emitSessionCreatedToHost(").length - 1).toBe(1);
  });
});
