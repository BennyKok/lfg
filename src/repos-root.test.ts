// An empty LFG_REPOS_ROOT is an unfilled placeholder, not a choice.
//
// .env is copied from .env.example, which ships `OMG_REPOS_ROOT=` as
// documentation. `??` only falls back on null/undefined, so that empty string
// became the repos root — and a folder picker asking the server for its default
// directory got 400 "folder does not exist", stranding the drawer on "Opening…"
// with nothing to navigate from. The picker's own fallback to the repos root
// landed on the same error, so it could not recover either.
import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { reposRoot } from "./projects.ts";

const KEY = "LFG_REPOS_ROOT";
const original = process.env[KEY];
afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("reposRoot", () => {
  test("uses a configured path", () => {
    process.env[KEY] = "/srv/code";
    expect(reposRoot()).toBe("/srv/code");
  });

  test("falls back when unset", () => {
    delete process.env[KEY];
    expect(reposRoot()).toBe(`${homedir()}/repos`);
  });

  // The regression: an empty assignment used to pass straight through.
  test("falls back when set but empty", () => {
    process.env[KEY] = "";
    expect(reposRoot()).toBe(`${homedir()}/repos`);
  });

  test("falls back when set to whitespace", () => {
    process.env[KEY] = "   ";
    expect(reposRoot()).toBe(`${homedir()}/repos`);
  });

  test("trims a padded value rather than using it verbatim", () => {
    process.env[KEY] = "  /srv/code  ";
    expect(reposRoot()).toBe("/srv/code");
  });

  test("never returns an empty string", () => {
    for (const value of ["", " ", "\t", "\n"]) {
      process.env[KEY] = value;
      expect(reposRoot().length).toBeGreaterThan(0);
    }
  });
});
