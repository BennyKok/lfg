import { describe, expect, test } from "bun:test";

import { resolveSessionUserTag } from "../src/users.ts";

const ROSTER = ["benny@omg.dev", "angel@omg.dev"];

describe("resolveSessionUserTag", () => {
  test("roster-less instance drops the tag instead of rejecting it", () => {
    // The regression: a hosted omg Computer has no LFG_USERS and no onboarding
    // profiles, so rosterEmails() is empty. A client that tags sessions with
    // the signed-in identity used to get
    //   400 unknown user "itechbenny@gmail.com" (expected one of the roster emails)
    // on EVERY session create, because [].includes(anything) is false.
    expect(resolveSessionUserTag("itechbenny@gmail.com", [])).toEqual({
      ok: true,
      user: undefined,
    });
    expect(resolveSessionUserTag(undefined, [])).toEqual({ ok: true, user: undefined });
  });

  test("a configured roster still rejects an unknown email", () => {
    expect(resolveSessionUserTag("stranger@example.com", ROSTER)).toEqual({
      ok: false,
      unknown: "stranger@example.com",
    });
  });

  test("a configured roster keeps a known email", () => {
    expect(resolveSessionUserTag("angel@omg.dev", ROSTER)).toEqual({
      ok: true,
      user: "angel@omg.dev",
    });
  });

  test("absent, blank and whitespace tags are unassigned, not errors", () => {
    for (const input of [undefined, null, "", "   "]) {
      expect(resolveSessionUserTag(input, ROSTER)).toEqual({ ok: true, user: undefined });
    }
  });

  test("surrounding whitespace does not make a roster member unknown", () => {
    expect(resolveSessionUserTag("  benny@omg.dev  ", ROSTER)).toEqual({
      ok: true,
      user: "benny@omg.dev",
    });
  });
});
