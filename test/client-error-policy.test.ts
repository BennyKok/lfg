import { describe, expect, test } from "bun:test";
import {
  clientErrorNoiseReason,
  isClientErrorNoise,
} from "../src/client-error-policy.ts";

describe("client error policy", () => {
  test.each([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop completed with undelivered notifications",
    "ResizeObserver loop limit exceeded",
  ])("drops the browser's non-actionable delivery notice: %s", (message) => {
    expect(clientErrorNoiseReason({ message })).toBe("resize-observer-delivery");
    expect(isClientErrorNoise({ message })).toBe(true);
  });

  test("does not hide an actionable error that merely mentions ResizeObserver", () => {
    expect(
      clientErrorNoiseReason({
        message: "ResizeObserver loop controller was undefined",
        stack: "Error: ResizeObserver loop controller was undefined\n at Artifact.tsx:42",
      }),
    ).toBeNull();
  });

  test("keeps attributed application failures actionable", () => {
    expect(
      clientErrorNoiseReason({
        message: "Failed to fetch session",
        componentStack: "at SessionView (App.tsx:42)",
      }),
    ).toBeNull();
  });
});
