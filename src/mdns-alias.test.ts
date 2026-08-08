// Advertising omg.local over mDNS is the only way to get a named local URL
// that costs the user nothing: no sudo for /etc/hosts, no DNS record, works
// offline. It is macOS-only on purpose — Linux would need avahi-daemon
// installed, and a first install has no business pulling in a system daemon
// for a nicer URL.
import { describe, expect, test } from "bun:test";
import {
  mdnsHostname,
  serviceInstanceName,
  startMdnsAlias,
  stopMdnsAlias,
  type MdnsDeps,
} from "./mdns-alias.ts";

function harness(overrides: Partial<MdnsDeps> = {}) {
  const commands: string[][] = [];
  const logs: string[] = [];
  let killed = 0;
  const deps: Partial<MdnsDeps> = {
    platform: "darwin",
    which: name => (name === "dns-sd" ? "/usr/bin/dns-sd" : null),
    spawn: command => {
      commands.push(command);
      return { kill: () => { killed += 1; } };
    },
    log: message => logs.push(message),
    ...overrides,
  };
  return { commands, logs, deps, killedCount: () => killed };
}

describe("which name gets advertised", () => {
  test("macOS defaults to omg.local", () => {
    expect(mdnsHostname("darwin", {})).toBe("omg.local");
  });

  test("other platforms advertise nothing", () => {
    expect(mdnsHostname("linux", {})).toBe("");
    expect(mdnsHostname("win32", {})).toBe("");
  });

  test("an explicit name is used verbatim, on any platform", () => {
    expect(mdnsHostname("darwin", { OMG_MDNS_HOSTNAME: "work.local" })).toBe("work.local");
    expect(mdnsHostname("linux", { OMG_MDNS_HOSTNAME: "work.local" })).toBe("work.local");
  });

  // An empty value is an answer — "advertise nothing" — not an absent one.
  // Treating it as unset would re-enable the default and ignore the opt-out.
  test("an explicitly empty name turns it off rather than falling back", () => {
    expect(mdnsHostname("darwin", { OMG_MDNS_HOSTNAME: "" })).toBe("");
    expect(mdnsHostname("darwin", { OMG_MDNS_HOSTNAME: "   " })).toBe("");
  });

  test("the legacy LFG_ spelling still works", () => {
    expect(mdnsHostname("darwin", { LFG_MDNS_HOSTNAME: "old.local" })).toBe("old.local");
  });

  test("OMG_ wins when both are set", () => {
    expect(mdnsHostname("darwin", { OMG_MDNS_HOSTNAME: "new.local", LFG_MDNS_HOSTNAME: "old.local" }))
      .toBe("new.local");
  });
});

describe("the dns-sd invocation", () => {
  test("registers a proxy record pointing at loopback", () => {
    const h = harness();
    const name = startMdnsAlias(8766, h.deps);

    expect(name).toBe("omg.local");
    expect(h.commands).toHaveLength(1);
    const [command] = h.commands;
    // -P is what makes this a *proxy* record: a name pointing at an address
    // that is not the advertising host's own. Without it the name would
    // resolve to this machine's LAN address, where nothing is listening.
    expect(command).toEqual([
      "/usr/bin/dns-sd",
      "-P",
      "omg",
      "_http._tcp",
      "local",
      "8766",
      "omg.local",
      "127.0.0.1",
    ]);
    stopMdnsAlias();
  });

  test("the instance name drops the domain", () => {
    expect(serviceInstanceName("omg.local")).toBe("omg");
    expect(serviceInstanceName("omg.local.")).toBe("omg");
    expect(serviceInstanceName("my-box.local")).toBe("my-box");
    // A name that is only the suffix must not become empty.
    expect(serviceInstanceName(".local")).toBe(".local");
  });
});

describe("failing without taking the server down", () => {
  // The loopback URL always works, so none of these are worth refusing to serve
  // over.
  test("does nothing on linux even when a name is configured", () => {
    const h = harness({ platform: "linux" });
    expect(startMdnsAlias(8766, { ...h.deps, platform: "linux" })).toBeNull();
    expect(h.commands).toHaveLength(0);
  });

  test("does nothing when dns-sd is missing", () => {
    const h = harness({ which: () => null });
    expect(startMdnsAlias(8766, h.deps)).toBeNull();
    expect(h.commands).toHaveLength(0);
  });

  test("does nothing when the name is turned off", () => {
    const h = harness();
    const before = process.env.OMG_MDNS_HOSTNAME;
    process.env.OMG_MDNS_HOSTNAME = "";
    try {
      expect(startMdnsAlias(8766, h.deps)).toBeNull();
      expect(h.commands).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.OMG_MDNS_HOSTNAME;
      else process.env.OMG_MDNS_HOSTNAME = before;
    }
  });

  test("a spawn that fails is not fatal", () => {
    const h = harness({ spawn: () => null });
    expect(startMdnsAlias(8766, h.deps)).toBeNull();
  });
});

describe("stopping", () => {
  test("kills the registration, and is safe to call twice", () => {
    const h = harness();
    startMdnsAlias(8766, h.deps);
    stopMdnsAlias();
    stopMdnsAlias();
    expect(h.killedCount()).toBe(1);
  });

  test("is safe when nothing was ever registered", () => {
    expect(() => stopMdnsAlias()).not.toThrow();
  });
});
