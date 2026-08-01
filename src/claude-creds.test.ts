import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOauthToken, resetClaudeCredsCacheForTests } from "./claude-creds.ts";

describe("Claude account credentials", () => {
  const originalHome = process.env.HOME;
  let testHome = "";

  // Stand in for a machine with nothing in the Keychain. The real reader is not
  // scoped to $HOME, so on a macOS box where the maintainer is signed in to
  // Claude Code it answers with their live token and the "initial miss" below
  // can never hold — the suite passed only on Linux or a signed-out Mac.
  const noKeychain = () => null;

  beforeEach(() => {
    resetClaudeCredsCacheForTests();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (testHome) rmSync(testHome, { recursive: true, force: true });
    testHome = "";
    resetClaudeCredsCacheForTests();
  });

  test("observes a browser login immediately after an initial miss", () => {
    testHome = mkdtempSync(join(tmpdir(), "lfg-claude-creds-"));
    process.env.HOME = testHome;
    expect(claudeOauthToken(undefined, noKeychain)).toBeNull();

    const credentialsDir = join(testHome, ".claude");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      join(credentialsDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-test-token" } }),
    );

    expect(claudeOauthToken(undefined, noKeychain)).toBe("oauth-test-token");
  });

  test("prefers the credentials file over the Keychain", () => {
    testHome = mkdtempSync(join(tmpdir(), "lfg-claude-creds-"));
    process.env.HOME = testHome;
    mkdirSync(join(testHome, ".claude"), { recursive: true });
    writeFileSync(
      join(testHome, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "from-file" } }),
    );

    // Pins the ordering the comment in claudeOauthToken relies on: a login that
    // just landed in the file must win over a stale Keychain entry, otherwise
    // the 60s cache hides it until it expires.
    expect(
      claudeOauthToken(undefined, () => ({ claudeAiOauth: { accessToken: "from-keychain" } })),
    ).toBe("from-file");
  });
});
