import { describe, expect, test } from "bun:test";

import { resolveRosterUser } from "../web/src/lib/roster-user.ts";

const USERS = [{ email: "benny@omg.dev" }, { email: "angel@omg.dev" }];

describe("resolveRosterUser", () => {
  test("a roster-less hosted Computer never replays a remembered email", () => {
    expect(resolveRosterUser("old-account@example.com", [])).toBe("");
  });

  test("a current roster member remains selected", () => {
    expect(resolveRosterUser("angel@omg.dev", USERS)).toBe("angel@omg.dev");
  });

  test("a stale or changed email falls back to a current roster member", () => {
    expect(resolveRosterUser("old-address@example.com", USERS)).toBe("benny@omg.dev");
  });

  test("an explicit blank keeps the session unassigned", () => {
    expect(resolveRosterUser("  ", USERS)).toBe("");
  });

  test("an absent selection uses the first current roster member", () => {
    expect(resolveRosterUser(undefined, USERS)).toBe("benny@omg.dev");
  });
});
