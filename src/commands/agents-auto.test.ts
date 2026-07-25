import { describe, expect, test } from "bun:test";
import {
  hasFlag,
  nextRunAt,
  option,
  options,
  parseBackendSelection,
  positional,
  resolveCwd,
} from "./agents-auto.ts";

describe("flag parsing", () => {
  test("positional skips values consumed by --flag value pairs", () => {
    expect(positional(["new", "--schedule", "0 9 * * *"])).toBe("new");
    // The idea itself may follow flags — the cron value must not be mistaken
    // for it just because it doesn't start with "--".
    expect(positional(["--schedule", "0 9 * * *", "watch the deps"])).toBe("watch the deps");
    // Boolean switches take no value, so the id right after one is still the id.
    expect(positional(["--json", "dep-watch"])).toBe("dep-watch");
    expect(positional(["--local", "dep-watch"])).toBe("dep-watch");
    expect(positional(["--cwd=/tmp/x", "dep-watch"])).toBe("dep-watch");
    expect(positional(["--json"])).toBeUndefined();
  });

  test("option reads both --k v and --k=v, across aliases", () => {
    expect(option(["--name", "watcher"], "--name")).toBe("watcher");
    expect(option(["--name=watcher"], "--name")).toBe("watcher");
    expect(option(["--agent", "grok"], "--backend", "--agent")).toBe("grok");
    expect(option(["--name"], "--name")).toBeUndefined();
  });

  test("options collects repeated and comma-joined values", () => {
    expect(options(["--tool", "Bash", "--tool=Write"], "--tool")).toEqual(["Bash", "Write"]);
  });

  test("hasFlag matches any alias", () => {
    expect(hasFlag(["--dry-run"], "--dry", "--dry-run")).toBe(true);
    expect(hasFlag(["--json"], "--dry", "--dry-run")).toBe(false);
  });
});

describe("backend selection", () => {
  test("defaults to aisdk and keeps the stored backend when no flag is given", () => {
    expect(parseBackendSelection([]).backend).toBe("aisdk");
    expect(parseBackendSelection([], "grok").backend).toBe("grok");
    // A stored backend the picker no longer offers must survive an unrelated
    // edit rather than being rejected as unknown.
    expect(parseBackendSelection(["--schedule", "0 9 * * *"], "hermes").backend).toBe("hermes");
  });

  test("an explicit backend wins over the stored one", () => {
    expect(parseBackendSelection(["--backend", "codex-aisdk"], "grok").backend).toBe("codex-aisdk");
  });

  test("passes through model, thinking level and tools", () => {
    const sel = parseBackendSelection([
      "--backend", "codex-aisdk",
      "--model", "gpt-5.5",
      "--tool", "Bash,Write",
    ]);
    expect(sel.model).toBe("gpt-5.5");
    expect(sel.tools).toEqual(["Bash", "Write"]);
    expect(parseBackendSelection([]).tools).toBeUndefined();
  });
});

describe("cwd resolution", () => {
  test("--no-repo beats both the flag and the fallback", () => {
    expect(resolveCwd(["--no-repo", "--cwd", "/tmp/x"], "/fallback")).toBeUndefined();
  });

  test("an explicit --cwd is absolutized, otherwise the fallback stands", () => {
    expect(resolveCwd(["--cwd", "/tmp/x"], "/fallback")).toBe("/tmp/x");
    expect(resolveCwd([], "/fallback")).toBe("/fallback");
    expect(resolveCwd([])).toBeUndefined();
  });
});

describe("nextRunAt", () => {
  test("finds the next matching minute in the given timezone", () => {
    const from = new Date("2026-07-25T10:00:00Z");
    const next = nextRunAt("0 9 * * *", "UTC", from);
    expect(next).not.toBeNull();
    expect(new Date(next!).toISOString()).toBe("2026-07-26T09:00:00.000Z");
  });

  test("a frequent schedule resolves to the very next slot", () => {
    const from = new Date("2026-07-25T10:07:30Z");
    const next = nextRunAt("*/15 * * * *", "UTC", from);
    expect(new Date(next!).toISOString()).toBe("2026-07-25T10:15:00.000Z");
  });

  test("an unmatchable schedule reports no next run instead of looping forever", () => {
    // Feb 30th never happens.
    expect(nextRunAt("0 9 30 2 *", "UTC", new Date("2026-07-25T10:00:00Z"))).toBeNull();
  });
});
