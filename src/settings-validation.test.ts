import { describe, expect, test } from "bun:test";
import { validTranscriptView } from "./settings.ts";

describe("global transcript view setting", () => {
  test("accepts only the two persisted view modes", () => {
    expect(validTranscriptView("full")).toBe(true);
    expect(validTranscriptView("user-lfg-output")).toBe(true);
    expect(validTranscriptView("focused")).toBe(false);
    expect(validTranscriptView(true)).toBe(false);
  });
});
