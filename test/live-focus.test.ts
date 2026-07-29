import { describe, expect, test } from "bun:test";
import { pendingLiveFocusRequest } from "../web/src/lib/live-focus";

describe("pendingLiveFocusRequest", () => {
  const focus = { sid: "session-a", n: 42 };

  test("handles one focus request only once across session-list refreshes", () => {
    const first = pendingLiveFocusRequest(focus, null, new Set(["session-a"]));
    expect(first).toEqual({ sid: "session-a", token: "session-a:42" });

    const refreshed = pendingLiveFocusRequest(
      focus,
      first?.token ?? null,
      new Set(["session-a", "session-b"]),
    );
    expect(refreshed).toBeNull();
  });

  test("waits until a resumed session appears", () => {
    expect(pendingLiveFocusRequest(focus, null, new Set())).toBeNull();
    expect(pendingLiveFocusRequest(focus, null, new Set(["session-a"]))).toEqual({
      sid: "session-a",
      token: "session-a:42",
    });
  });

  test("accepts a new request for the same session", () => {
    expect(
      pendingLiveFocusRequest(
        { sid: "session-a", n: 43 },
        "session-a:42",
        new Set(["session-a"]),
      ),
    ).toEqual({ sid: "session-a", token: "session-a:43" });
  });
});
