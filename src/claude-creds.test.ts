import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOauthToken } from "./claude-creds.ts";

describe("Claude account credentials", () => {
  const originalHome = process.env.HOME;
  let testHome = "";

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (testHome) rmSync(testHome, { recursive: true, force: true });
    testHome = "";
  });

  test("observes a browser login immediately after an initial miss", () => {
    testHome = mkdtempSync(join(tmpdir(), "lfg-claude-creds-"));
    process.env.HOME = testHome;
    expect(claudeOauthToken()).toBeNull();

    const credentialsDir = join(testHome, ".claude");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      join(credentialsDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-test-token" } }),
    );

    expect(claudeOauthToken()).toBe("oauth-test-token");
  });
});
