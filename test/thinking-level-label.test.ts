import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const app = () => readFile("web/src/App.tsx", "utf8");

describe("thinking level menu", () => {
  test("uses a stable Thinking label while retaining the level choices", async () => {
    const source = await app();
    const start = source.indexOf("function ThinkingLevelPill(");
    const end = source.indexOf("function ModelPicker(", start);
    const pill = source.slice(start, end);

    expect(pill).toContain('>Thinking</span>');
    expect(pill).toContain('aria-label="Thinking"');
    expect(pill).toContain("title={`Thinking: ${value}`}");
    expect(pill).toContain("{levels.map((item) => (");
    expect(pill).not.toContain('aria-label="Thinking level"');
  });

  test("all composer surfaces use the shared labeled menu", async () => {
    const source = await app();
    expect(source.match(/<ThinkingLevelPill/g)?.length).toBe(3);
    expect(source).not.toContain('aria-label="Thinking level"');
  });
});
