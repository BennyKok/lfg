import { describe, expect, test } from "bun:test";
import { visibilityRecoveryAction } from "../web/src/live-visibility.ts";

describe("live socket visibility recovery", () => {
  test("reconnects when a hidden-tab close was deferred", () => {
    expect(visibilityRecoveryAction(null, true)).toBe("connect");
  });

  test("probes a socket that still claims to be open", () => {
    expect(visibilityRecoveryAction(1, false)).toBe("probe");
  });

  test("does not replace a connection already in flight", () => {
    expect(visibilityRecoveryAction(0, false)).toBe("wait");
  });

  test("reconnects sockets that are closing or closed", () => {
    expect(visibilityRecoveryAction(2, false)).toBe("connect");
    expect(visibilityRecoveryAction(3, false)).toBe("connect");
  });
});
