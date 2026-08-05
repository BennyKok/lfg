// boxTextMatches / messageNeedles — delivery confirmation for the confirmed-
// send queue. The live bug (2026-08-05): multi-line ask-user answers typed into
// a Grok composer kept only the first two lines (no "Their reply"), but sendq
// confirmed delivery on a 48-char *prefix* alone, so the agent saw an empty
// answer body while the store had the real choice.

import { describe, expect, test } from "bun:test";
import {
  boxTextMatches,
  messageNeedles,
  textHasMessageNeedles,
} from "../src/sendq.ts";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("messageNeedles", () => {
  test("short messages have no tail", () => {
    const { head, tail } = messageNeedles("hello world, short");
    expect(head).toBe("hello world, short");
    expect(tail).toBeNull();
  });

  test("long messages require a tail needle", () => {
    const full = "HEAD_UNIQUE_" + "m".repeat(160) + "_TAIL_UNIQUE_END";
    const { head, tail } = messageNeedles(full);
    expect(head.startsWith("HEAD_UNIQUE_")).toBe(true);
    expect(tail).not.toBeNull();
    expect(tail!.includes("TAIL_UNIQUE")).toBe(true);
    expect(textHasMessageNeedles(full, head, tail)).toBe(true);
    // Truncated to head only — must NOT confirm.
    expect(textHasMessageNeedles(full.slice(0, 80), head, tail)).toBe(false);
  });
});

describe("boxTextMatches", () => {
  test("short draft: head needle is enough", () => {
    const full = norm("yes, ship it");
    const needle = full.slice(0, 48);
    expect(boxTextMatches("yes, ship it", full, needle)).toBe(true);
  });

  test("empty box never matches", () => {
    const full = norm("anything at all here is fine");
    expect(boxTextMatches("", full, full.slice(0, 48))).toBe(false);
    expect(boxTextMatches("   ", full, full.slice(0, 48))).toBe(false);
  });

  test("foreign draft / placeholder does not match", () => {
    const full = norm(
      "[ask-user answer abcd] Their reply: B: keep both\nQuestion: which path?\nIf it answers…",
    );
    const needle = full.slice(0, 48);
    expect(boxTextMatches("Add a follow-up", full, needle)).toBe(false);
    expect(boxTextMatches("something completely different", full, needle)).toBe(
      false,
    );
  });

  test("partial PREFIX of a long multi-line draft does not match (the empty-reply bug)", () => {
    // Repro of the live envelope shape: first two lines typed, answer line lost.
    const full = norm(
      "[ask-user answer 45bd680b6a2b] The user replied while this question was open. " +
        "Question: Which path for benny@omg.dev Gmail? (Previous answer was empty.) " +
        "A=switch native connector to benny@omg.dev. B=keep itechbenny + add second MCP. " +
        "C=just send me the reconnect steps. " +
        "Their reply: B: keep both (second MCP) " +
        "If it answers the question, act on it now — it is the user's decision, and do not ask again.",
    );
    const needle = full.slice(0, 48);
    const partial =
      "[ask-user answer 45bd680b6a2b] The user replied while this question was open.\n" +
      "Question: Which path for benny@omg.dev Gmail? (Previous answer was empty.) " +
      "A=switch native connector to benny@omg.dev. B=keep itechbenny + add second MCP. " +
      "C=just send me the reconnect steps.";
    expect(norm(partial).includes(needle)).toBe(true); // head alone would have fired
    expect(boxTextMatches(partial, full, needle)).toBe(false);
    // Full text in the box (even with newlines) matches.
    const fullBoxed = full.replace(/\. /g, ".\n"); // wrap-ish
    // Rebuild as the real multi-line envelope for a positive control.
    const complete =
      "[ask-user answer 45bd680b6a2b] The user replied while this question was open.\n" +
      "Question: Which path for benny@omg.dev Gmail? (Previous answer was empty.) " +
      "A=switch native connector to benny@omg.dev. B=keep itechbenny + add second MCP. " +
      "C=just send me the reconnect steps.\n" +
      "Their reply: B: keep both (second MCP)\n" +
      "If it answers the question, act on it now — it is the user's decision, and do not ask again.";
    expect(boxTextMatches(complete, norm(complete), norm(complete).slice(0, 48))).toBe(
      true,
    );
  });

  test("scrolled mid-draft (codex): visible slice of ours matches", () => {
    const full = norm(
      "HEADSTART unique opener then " +
        "middle_payload_xyz ".repeat(20) +
        "TAIL_MARKER_END_OF_MESSAGE unique finish",
    );
    const needle = full.slice(0, 48);
    // Viewport shows a middle slice only — no head, no tail.
    const midStart = full.indexOf("middle_payload_xyz");
    const mid = full.slice(midStart, midStart + 80);
    expect(mid.includes(needle)).toBe(false);
    expect(mid.includes("TAIL_MARKER")).toBe(false);
    expect(boxTextMatches(mid, full, needle)).toBe(true);
  });

  test("scrolled tail-only still matches via inverted check", () => {
    const full = norm("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda");
    // pad to long
    const long = norm(full + " " + "x".repeat(100) + " ENDTAIL");
    const needle = long.slice(0, 48);
    const tailSlice = long.slice(-60);
    expect(tailSlice.includes(needle)).toBe(false);
    expect(boxTextMatches(tailSlice, long, needle)).toBe(true);
  });

  test("mid-word wrap seam does not invent a space", () => {
    // Visible lines are "someverylongwo" + "rdcontinues" which join without space
    // in the real draft as "someverylongwordcontinues".
    const full = norm("prefix someverylongwordcontinues suffix " + "y".repeat(100));
    const needle = full.slice(0, 48);
    const box = "someverylongwo\nrdcontinues";
    // Each line is a substring of fullNorm (no space at seam).
    expect(boxTextMatches(box, full, needle)).toBe(true);
  });
});
