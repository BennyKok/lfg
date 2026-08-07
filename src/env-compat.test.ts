import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEnvAliases, ENV_PREFIX, ENV_PREFIX_LEGACY } from "./env-compat.ts";

describe("OMG_/LFG_ env aliasing", () => {
  test("an existing install's LFG_* config still reaches OMG_* readers", () => {
    const env = { LFG_PORT: "8766", LFG_HOST: "127.0.0.1" };
    applyEnvAliases(env);
    expect(env).toMatchObject({ OMG_PORT: "8766", OMG_HOST: "127.0.0.1" });
  });

  test("a new install's OMG_* config still reaches the LFG_* read sites", () => {
    const env = { OMG_PORT: "9000", OMG_REPOS_ROOT: "/srv/repos" };
    applyEnvAliases(env);
    expect(env).toMatchObject({ LFG_PORT: "9000", LFG_REPOS_ROOT: "/srv/repos" });
  });

  test("OMG_ wins when a name is set both ways", () => {
    const env = { OMG_PORT: "9000", LFG_PORT: "8766" };
    applyEnvAliases(env);
    expect(env.LFG_PORT).toBe("9000");
    expect(env.OMG_PORT).toBe("9000");
  });

  test("empty string is a real value, not an absent one", () => {
    // TAR_OPTIONS-style blanking: LFG_FOO= must not be resurrected from a
    // stale counterpart, and must propagate as the empty string.
    const env: Record<string, string | undefined> = { OMG_FOO: "", LFG_FOO: "set" };
    applyEnvAliases(env);
    expect(env.LFG_FOO).toBe("");
  });

  test("leaves unrelated and bare-prefix variables alone", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test",
      LFG_: "bare",
      OMG_: "bare",
    };
    applyEnvAliases(env);
    expect(env).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test",
      LFG_: "bare",
      OMG_: "bare",
    });
  });

  test("is idempotent", () => {
    const env = { OMG_PORT: "9000", LFG_HOST: "127.0.0.1" };
    applyEnvAliases(env);
    const once = { ...env };
    applyEnvAliases(env);
    expect(env).toEqual(once);
  });

  test("prefixes stay distinct so aliasing cannot become a no-op", () => {
    expect(ENV_PREFIX).not.toBe(ENV_PREFIX_LEGACY);
  });

  // The shim only works if it runs before any command module is imported --
  // serve.ts captures `LFG_HOST` into a module-level const. If someone adds a
  // static import above it, or moves the call below the first dynamic import,
  // the aliasing silently stops applying to those consts.
  test("cli.ts aliases env before importing any command module", () => {
    const cli = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
    const alias = cli.indexOf("applyEnvAliases()");
    const firstCommandImport = cli.indexOf('await import("./commands/');
    expect(alias).toBeGreaterThan(-1);
    expect(firstCommandImport).toBeGreaterThan(-1);
    expect(alias).toBeLessThan(firstCommandImport);
    expect(cli).not.toMatch(/^import\s.*from\s+"\.\/commands\//m);
  });
});
