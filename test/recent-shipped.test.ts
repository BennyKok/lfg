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

  // Regression: this is called from a render-phase useMemo with state fed
  // straight off GET /api/shipped. On the hosted surface that request is proxied
  // to a remote workspace which can answer 2xx without the array, and spreading
  // the resulting `undefined` threw "Spread syntax requires ...iterable not be
  // null or undefined" inside render — taking the entire app down behind the
  // router's catch boundary.
  test("survives a response body that carried no posts array", () => {
    expect(latestDistinctShippedSessions(undefined)).toEqual([]);
    expect(latestDistinctShippedSessions(null)).toEqual([]);
    expect(latestDistinctShippedSessions([])).toEqual([]);
  });
});
