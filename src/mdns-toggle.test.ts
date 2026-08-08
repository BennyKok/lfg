// The named local URL is a Settings toggle rather than an install-time flag,
// because turning it on costs nothing and needs no privilege: registering an
// mDNS record is unprivileged. That is the whole reason this is safe to expose
// on an API that has no authentication of its own — unlike the /etc/hosts route
// it replaced, which would have meant a web request triggering sudo.
import { describe, expect, test } from "bun:test";
import { mdnsStatus, setMdnsEnabled, stopMdnsAlias } from "./mdns-alias.ts";
import { getGlobalSettingsSync } from "./settings.ts";

function harness(overrides: Record<string, unknown> = {}) {
  const commands: string[][] = [];
  let killed = 0;
  return {
    commands,
    killedCount: () => killed,
    deps: {
      platform: "darwin" as NodeJS.Platform,
      which: (name: string) => (name === "dns-sd" ? "/usr/bin/dns-sd" : null),
      spawn: (command: string[]) => {
        commands.push(command);
        return { kill: () => { killed += 1; } };
      },
      log: () => {},
      ...overrides,
    },
  };
}

describe("capability reporting", () => {
  test("macOS with dns-sd is supported", () => {
    const status = mdnsStatus({ platform: "darwin", which: () => "/usr/bin/dns-sd" });
    expect(status.supported).toBe(true);
  });

  // Reported as unsupported rather than hidden, so the UI can say why instead
  // of offering a switch that silently does nothing.
  test("linux is unsupported", () => {
    expect(mdnsStatus({ platform: "linux", which: () => "/usr/bin/dns-sd" }).supported).toBe(false);
  });

  test("macOS without dns-sd is unsupported", () => {
    expect(mdnsStatus({ platform: "darwin", which: () => null }).supported).toBe(false);
  });
});

describe("toggling at runtime", () => {
  test("enabling advertises, disabling withdraws", () => {
    stopMdnsAlias();
    const h = harness();

    const name = setMdnsEnabled(true, 8766, h.deps);
    expect(name).toBe("omg.local");
    expect(h.commands).toHaveLength(1);
    expect(mdnsStatus({ platform: "darwin", which: () => "/usr/bin/dns-sd" }).active).toBe(true);

    setMdnsEnabled(false, 8766, h.deps);
    expect(h.killedCount()).toBe(1);
    expect(mdnsStatus({ platform: "darwin", which: () => "/usr/bin/dns-sd" }).active).toBe(false);
  });

  // A settings POST can arrive when the state already matches; that must not
  // spawn a second advertiser for the same name.
  test("enabling twice does not register twice", () => {
    stopMdnsAlias();
    const h = harness();
    setMdnsEnabled(true, 8766, h.deps);
    setMdnsEnabled(true, 8766, h.deps);
    expect(h.commands).toHaveLength(1);
    stopMdnsAlias();
  });

  test("disabling when already off is a no-op", () => {
    stopMdnsAlias();
    const h = harness();
    expect(setMdnsEnabled(false, 8766, h.deps)).toBeNull();
    expect(h.killedCount()).toBe(0);
  });
});

describe("the persisted preference", () => {
  test("defaults to on", () => {
    expect(getGlobalSettingsSync().localUrlEnabled).toBe(true);
  });
});

describe("persistence", () => {
  // setGlobalSettings writes an explicit key list rather than iterating the
  // object, so a new setting sanitizes into the response and is silently never
  // stored — the POST looks like it worked and the next GET shows the old
  // value. This asserts every field of GlobalSettings is actually written.
  test("every setting key is persisted, not just returned", async () => {
    const source = await Bun.file(new URL("./settings.ts", import.meta.url)).text();
    const typeBlock = source.slice(
      source.indexOf("export type GlobalSettings = {"),
      source.indexOf("};", source.indexOf("export type GlobalSettings = {")),
    );
    const fields = [...typeBlock.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
    expect(fields.length).toBeGreaterThan(0);

    const writer = source.slice(source.indexOf("database.transaction("), source.indexOf("})();"));
    for (const field of fields) {
      expect(writer, `${field} is never written by setGlobalSettings`).toContain(`write.run("${field}"`);
    }
  });
});
