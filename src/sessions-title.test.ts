import { describe, expect, test } from "bun:test";
import type { ManagedSession } from "./managed.ts";
import { managedHistoricalTitle } from "./sessions.ts";

const managed: ManagedSession = {
  tmuxName: "lfg-current",
  cwd: "/home/dev/repos/vibes",
  createdAt: 1,
  sessionId: "11111111-1111-4111-8111-111111111111",
  nativeSessionId: "22222222-2222-4222-8222-222222222222",
  title: "Current session title",
};

describe("historical session titles", () => {
  test("does not reuse a same-cwd managed title for another session", () => {
    expect(
      managedHistoricalTitle(managed, "33333333-3333-4333-8333-333333333333", {}),
    ).toBeNull();
  });

  test("keeps exact managed titles and per-session overrides", () => {
    expect(managedHistoricalTitle(managed, managed.nativeSessionId!, {})).toBe(
      "Current session title",
    );
    expect(
      managedHistoricalTitle(managed, managed.nativeSessionId!, {
        [managed.sessionId!]: "Renamed session",
      }),
    ).toBe("Renamed session");
    expect(
      managedHistoricalTitle(managed, "33333333-3333-4333-8333-333333333333", {
        "33333333-3333-4333-8333-333333333333": "Historical override",
      }),
    ).toBe("Historical override");
  });
});
