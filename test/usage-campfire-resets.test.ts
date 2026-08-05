import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const campfire = readFileSync("web/src/components/UsageCampfire.tsx", "utf8");

describe("usage campfire reset visibility", () => {
  test("keeps secondary resets visible while a provider is focused", () => {
    expect(campfire).toContain("const otherFocusedResets = useMemo(");
    expect(campfire).toContain('aria-label="Other upcoming resets"');
    expect(campfire).toContain('{" restores "}');
    expect(campfire).toContain("formatResetShort(window.resetsAt, now)");
  });

  test("only lists future resets other than the featured countdown", () => {
    expect(campfire).toContain("window.resetsAt > now");
    expect(campfire).toContain("window.resetsAt !== heroReset");
  });
});
