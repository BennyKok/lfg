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
  opts: {
    installed?: boolean;
    authed?: boolean;
    runtimeAuthed?: boolean;
    canAutoSetup?: boolean;
  } = {},
): ConnectAgentInfo {
  const installed = opts.installed !== false;
  const authed = opts.authed === true;
  const runtimeAuthed = opts.runtimeAuthed ?? authed;
  const label = key.includes("codex") ? "Codex" : key === "grok" ? "Grok" : "Claude";
  return {
    key,
    label,
    status: {
      configured: installed && runtimeAuthed,
      accountConnected: authed,
      canAutoSetup: opts.canAutoSetup !== false,
      checks: [
        { label: `${label} CLI`, ok: installed },
        { label: `${label} auth`, ok: authed },
      ],
    },
  };
}

const FRESH_BOX = [agent("aisdk"), agent("codex-aisdk"), agent("grok")];

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

  test("closes when Grok connects", () => {
    const connected = [agent("claude"), agent("codex"), agent("grok", { authed: true })];
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: connected })).toBe(false);
  });

  test("a login reported only on the ai-sdk sibling also closes it", () => {
    // Production exposes the ai-sdk roster key, and its explicit account
    // signal closes the gate after browser login.
    const connected = [agent("claude"), agent("aisdk", { authed: true }), agent("codex")];
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: connected })).toBe(false);
  });

  test("platform API keys make agents runnable but do not impersonate a user connection", () => {
    const platformConfigured = [
      agent("aisdk", { runtimeAuthed: true }),
      agent("codex-aisdk", { runtimeAuthed: true }),
    ];
    expect(platformConfigured.every((item) => item.status.configured)).toBe(true);
    expect(hasConnectedGateProvider(platformConfigured)).toBe(false);
    expect(
      shouldShowEmbeddedConnectGate({ embedded: true, agents: platformConfigured }),
    ).toBe(true);
  });

  test("bundled pi / OpenCode must NOT satisfy the gate on a fresh image", () => {
    // agent-lfg ships pi bundled (file-based auth) and can carry OpenCode or
    // Copilot creds in the image. Those report configured while the user still
    // has no offered provider login, so the connect prompt must stay up.
    const imageDefaults = [
      ...FRESH_BOX,
      agent("pi", { authed: true }),
      agent("opencode", { authed: true }),
      agent("copilot", { authed: true }),
    ];
    expect(hasConnectedGateProvider(imageDefaults)).toBe(false);
    expect(shouldShowEmbeddedConnectGate({ embedded: true, agents: imageDefaults })).toBe(true);
    // …and it closes only once an offered provider connects.
    expect(
      shouldShowEmbeddedConnectGate({
        embedded: true,
        agents: [
          ...imageDefaults.slice(FRESH_BOX.length),
          agent("claude", { authed: true }),
          agent("codex"),
          agent("grok"),
        ],
      }),
    ).toBe(false);
    // Someone deliberately using pi/OpenCode takes the skip link.
    expect(
      shouldShowEmbeddedConnectGate({ embedded: true, agents: imageDefaults, dismissed: true }),
    ).toBe(false);
  });

  test("a host-mounted settings page is never replaced by onboarding", () => {
    // The gate returns before the shell, so it replaces the ENTIRE tree. That
    // is right for a framed full app — its whole job is running sessions, and
    // it can't run one without an agent — and wrong for a host that mounted a
    // single settings page: the user asked to change a setting, and got an
    // onboarding card where their settings should have been, with no way to
    // reach the page at all.
    expect(
      shouldShowEmbeddedConnectGate({ embedded: true, bare: true, agents: FRESH_BOX }),
    ).toBe(false);
    // …and the framed full app is untouched.
    expect(
      shouldShowEmbeddedConnectGate({ embedded: true, bare: false, agents: FRESH_BOX }),
    ).toBe(true);
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
  test("offers Claude Code and Codex while Grok is hidden", () => {
    const options = embeddedConnectOptions(FRESH_BOX);
    expect(options.map((o) => o.kind)).toEqual(["aisdk", "codex-aisdk"]);
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

  test("uses the installed ai-sdk roster key to drive the existing login endpoint", () => {
    expect(embeddedConnectOptions([agent("aisdk")])).toEqual([
      expect.objectContaining({ provider: "claude", kind: "aisdk" }),
    ]);
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
    expect(gate.slice(0, gate.indexOf("</>"))).toContain("loginTool(key)");
  });

  test("the gate includes a second tools page with a real GitHub connection", () => {
    const component = require("node:fs").readFileSync(
      "web/src/components/embedded-connect-gate.tsx",
      "utf8",
    ) as string;
    expect(component).toContain("Connect your tools");
    expect(component).toContain("onConnectTool(tool.key)");
    expect(component).toContain("tool.detail");
    const connections = require("node:fs").readFileSync("src/tool-connections.ts", "utf8") as string;
    expect(connections).toContain("Private repos, pushes, and pull requests");
    expect(app).toContain('`/api/connections/${key}/auth`');
  });

  test("a session deep link is never held behind the gate", () => {
    expect(app).toContain("dismissed: connectGateSkipped || !!sessionDeepLinkRef.current");
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

describe("host-mounted settings navigation", () => {
  const embedded = require("node:fs").readFileSync("web/src/embedded.tsx", "utf8") as string;
  const dts = require("node:fs").readFileSync("web/src/embedded.d.ts", "utf8") as string;

  test("the surface reports where it navigated, and accepts being driven back", () => {
    // The surface runs on a memory history, so without this a host with its own
    // router shows ONE url for five different screens: the device back button
    // leaves the whole surface instead of going up a page, and no page inside
    // it is linkable.
    expect(embedded).toContain("onNavigate?: (page: LfgSettingsPage) => void");
    expect(embedded).toContain('router.subscribe("onResolved"');
    // Controlled: the host echoing back the page we just reported must not
    // navigate a second time.
    expect(embedded).toContain(
      "if (pathToSettingsPage(router.state.location.pathname) === page) return;",
    );
    // The published types are hand-written, so they drift silently unless
    // pinned alongside the implementation.
    expect(dts).toContain("onNavigate?: (page: LfgSettingsPage) => void");
  });

  test("only real settings pages are reported outward", () => {
    // Any unknown first segment renders SettingsView (the app's catch-all), so
    // an unfiltered pathname→page cast would hand the host a page id it has no
    // route for.
    expect(embedded).toContain("SETTINGS_PAGES.includes(page) ? page : null");
  });
});

describe("host-mounted page layout", () => {
  const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;
  const css = require("node:fs").readFileSync("web/src/index.css", "utf8") as string;

  test("a mounted page fills the host's column instead of nesting its own", () => {
    // Standalone, each page centres itself in a max-w-xl column — that IS the
    // page. Inside a host that has already centred and padded its settings
    // column, ours became a second column inside it: every card sat inset from
    // the host's own cards, and the mount read as a panel dropped into the page
    // rather than part of it.
    expect(app).toContain('className="mx-auto max-w-xl space-y-8 pb-10" data-lfg-page-column');
    expect(css).toContain("[data-lfg-settings-surface] [data-lfg-page-column]");
    expect(css).toMatch(
      /\[data-lfg-settings-surface\] \[data-lfg-page-column\]\s*\{[^}]*max-width:\s*none/,
    );
    // Scoped to the settings surface: the full embedded app brings its own
    // shell and does want its column.
    expect(css).not.toMatch(/^\s*\[data-lfg-page-column\]\s*\{/m);
  });
});

describe("bare is a property of a tree, not of the process", () => {
  const embedded = require("node:fs").readFileSync("web/src/embedded.tsx", "utf8") as string;
  const embed = require("node:fs").readFileSync("web/src/lib/embed.ts", "utf8") as string;
  const app = require("node:fs").readFileSync("web/src/App.tsx", "utf8") as string;

  test("two surfaces in one document cannot overwrite each other's chrome", () => {
    // The regression: `bare` was a module-level boolean set by the entry point.
    // A host that mounts BOTH surfaces shares one module instance, and omg keeps
    // the Computer surface alive off-screen while you open Settings — so opening
    // settings once left the flag true for the life of the SPA, and every later
    // full-app render lost its header, gutter and header inset until a reload.
    expect(embed).not.toContain("let bareSurface");
    expect(embed).not.toContain("export function setBareSurface");
    expect(embedded).not.toContain("setBareSurface(");

    // Each surface declares its own, and components read the tree's value.
    expect(embedded).toContain("<BareSurfaceProvider bare>");
    expect(embedded).toContain("<BareSurfaceProvider bare={false}>");
    expect(app).toContain("const bare = useBareSurface();");
    expect(app).not.toContain("const bare = isBareSurface();");
  });

  test("?bare=1 still works for inspecting the hosted layout in a browser", () => {
    expect(embed).toContain('get("bare") === "1"');
  });
});
