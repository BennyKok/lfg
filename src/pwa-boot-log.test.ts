import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_ENTRIES,
  clear,
  launchPathKind,
  parseBeacon,
  record,
  recordRequest,
  snapshot,
  verdict,
} from "./pwa-boot-log.ts";

beforeEach(() => clear());

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe("launchPathKind", () => {
  test("marks the paths a cold start must hit", () => {
    expect(launchPathKind("/")).toBe("document");
    expect(launchPathKind("/index.html")).toBe("document");
    expect(launchPathKind("/sw.js")).toBe("service-worker");
    expect(launchPathKind("/manifest.webmanifest")).toBe("manifest");
    expect(launchPathKind("/assets/index-CRmvcm3W.js")).toBe("entry-chunk");
  });

  test("ignores everything else so a launch is not buried in noise", () => {
    expect(launchPathKind("/api/sessions")).toBeNull();
    expect(launchPathKind("/assets/react-vendor-CdCy4TEt.js")).toBeNull();
    expect(launchPathKind("/assets/index-CNdXiETs.css")).toBeNull();
    expect(launchPathKind("/icon-192.png")).toBeNull();
  });
});

describe("recordRequest", () => {
  test("captures the navigation hints that identify a real cold launch", () => {
    recordRequest("/", headers({ "user-agent": "iPhone", "sec-fetch-dest": "document" }));
    const [entry] = snapshot();
    expect(entry.source).toBe("request");
    expect(entry.label).toBe("document");
    expect(entry.detail?.dest).toBe("document");
  });

  test("skips unrelated paths", () => {
    recordRequest("/api/sessions", headers({ "user-agent": "iPhone" }));
    expect(snapshot()).toHaveLength(0);
  });
});

describe("repeat collapsing", () => {
  test("the 60s service-worker poll cannot bury a launch", () => {
    for (let i = 0; i < 50; i++) {
      recordRequest("/sw.js", headers({ "user-agent": "Mac" }));
    }
    const all = snapshot();
    expect(all).toHaveLength(1);
    expect(all[0].repeat).toBe(50);
  });

  test("a different device is never folded into another's entry", () => {
    recordRequest("/sw.js", headers({ "user-agent": "Mac" }));
    recordRequest("/sw.js", headers({ "user-agent": "iPhone" }));
    expect(snapshot()).toHaveLength(2);
  });

  test("beacons keep their sequence so the verdict can read it", () => {
    const beacon = () => ({ t: Date.now(), source: "beacon" as const, label: "html-parsed" });
    record(beacon());
    record(beacon());
    expect(snapshot()).toHaveLength(2);
  });

  test("marks outside the collapse window are separate events", () => {
    record({ t: Date.now() - 5 * 60_000, source: "request", label: "document", ua: "iPhone" });
    record({ t: Date.now(), source: "request", label: "document", ua: "iPhone" });
    expect(snapshot()).toHaveLength(2);
  });
});

describe("parseBeacon", () => {
  test("accepts a well-formed phase report", () => {
    const entry = parseBeacon(
      JSON.stringify({
        phase: "app-mounted",
        bootId: "abc",
        mode: "standalone",
        detail: { rootChildren: 1 },
      }),
      "iPhone",
    );
    expect(entry?.label).toBe("app-mounted");
    expect(entry?.mode).toBe("standalone");
    expect(entry?.detail?.rootChildren).toBe(1);
  });

  test("rejects junk rather than trusting a misbehaving install", () => {
    expect(parseBeacon("not json")).toBeNull();
    expect(parseBeacon(JSON.stringify({ phase: "made-up" }))).toBeNull();
    expect(parseBeacon(JSON.stringify({ nope: 1 }))).toBeNull();
  });

  test("clamps unbounded detail so a looping page cannot flood the log", () => {
    const detail: Record<string, string> = {};
    for (let i = 0; i < 60; i++) detail[`k${i}`] = "x".repeat(5000);
    const entry = parseBeacon(JSON.stringify({ phase: "stuck", detail }));
    expect(Object.keys(entry!.detail!).length).toBeLessThanOrEqual(12);
    for (const value of Object.values(entry!.detail!)) {
      expect(String(value).length).toBeLessThanOrEqual(300);
    }
  });
});

test("the ring buffer stays bounded", () => {
  for (let i = 0; i < MAX_ENTRIES + 50; i++) {
    // Distinct labels so collapsing does not mask the bound being tested.
    record({ t: Date.now(), source: "beacon", label: `html-parsed`, detail: { i } });
  }
  expect(snapshot()).toHaveLength(MAX_ENTRIES);
});

describe("verdict", () => {
  const at = (label: string, source: "request" | "beacon") => ({
    t: Date.now(),
    source,
    label,
  });

  test("silence means the phone never reached the server", () => {
    expect(verdict([]).headline).toBe("No launch reached this server");
  });

  test("stale entries do not count as a launch", () => {
    const old = { t: Date.now() - 60 * 60_000, source: "request" as const, label: "document" };
    expect(verdict([old]).headline).toBe("No launch reached this server");
  });

  test("a document fetch with no page report is a delivery failure", () => {
    expect(verdict([at("document", "request")]).headline).toBe("Page fetched, but never executed");
  });

  test("html-parsed without a mount blames the bundle", () => {
    expect(verdict([at("document", "request"), at("html-parsed", "beacon")]).headline).toBe(
      "Page ran, then went quiet",
    );
  });

  test("a mount means the fault is inside the UI, not the install", () => {
    expect(
      verdict([at("document", "request"), at("html-parsed", "beacon"), at("app-mounted", "beacon")])
        .headline,
    ).toBe("The app mounted");
  });

  test("a stuck report outranks html-parsed but not a mount", () => {
    expect(
      verdict([at("document", "request"), at("html-parsed", "beacon"), at("stuck", "beacon")])
        .headline,
    ).toBe("Loaded, but the app never mounted");
  });

  test("sub-resources without a page request point at the worker or start_url", () => {
    expect(verdict([at("service-worker", "request")]).headline).toBe(
      "Sub-resources only — no page request",
    );
  });
});
