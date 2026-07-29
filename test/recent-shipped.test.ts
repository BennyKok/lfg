import { describe, expect, test } from "bun:test";
import { latestDistinctShippedSessions } from "../web/src/lib/recent-shipped";

describe("latestDistinctShippedSessions", () => {
  test("returns the five newest distinct sessions", () => {
    const posts = [
      { id: "old-a", sessionId: "a", ts: 10 },
      { id: "new-a", sessionId: "a", ts: 70 },
      { id: "no-session", ts: 100 },
      { id: "b", sessionId: "b", ts: 60 },
      { id: "c", sessionId: "c", ts: 50 },
      { id: "d", sessionId: "d", ts: 40 },
      { id: "e", sessionId: "e", ts: 30 },
      { id: "f", sessionId: "f", ts: 20 },
    ];

    expect(latestDistinctShippedSessions(posts).map((post) => post.id)).toEqual([
      "new-a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("returns only sessions from the selected project", () => {
    const posts = [
      { id: "lfg-new", sessionId: "lfg-new", project: "lfg", ts: 50 },
      { id: "omg-new", sessionId: "omg-new", project: "omg", ts: 40 },
      { id: "lfg-old", sessionId: "lfg-old", project: "lfg", ts: 30 },
      { id: "missing-project", sessionId: "legacy", ts: 60 },
    ];

    expect(
      latestDistinctShippedSessions(posts, 5, "lfg").map((post) => post.id),
    ).toEqual(["lfg-new", "lfg-old"]);
  });
});
