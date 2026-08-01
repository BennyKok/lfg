import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadChromium, loadSharp } from "./native-deps.ts";

const SRC = import.meta.dir;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    out.push(path);
  }
  return out;
}

// A top-level `import ... from "sharp"` / `"playwright"` anywhere reachable
// from `lfg serve` drags the native addon into every server process at import
// time — ~100 MB and ~90 MB of RSS respectively, whether or not the process
// ever encodes an image or drives a browser. That is what OOM-killed opencode
// beside LFG inside a 512 MiB free-plan Cloud Computer guest. Value access has
// to go through native-deps.ts so the cost is paid on first use instead.
describe("native dependencies stay lazily loaded", () => {
  const STATIC_IMPORT = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s*["'](sharp|playwright)["']/m;

  test("no module statically imports sharp or playwright for its value", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith(`${SRC}/native-deps.ts`) || file === join(SRC, "native-deps.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (STATIC_IMPORT.test(source)) offenders.push(file.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  test("native-deps reaches the packages through dynamic import only", () => {
    const source = readFileSync(join(SRC, "native-deps.ts"), "utf8");
    expect(source).toContain('import("sharp")');
    expect(source).toContain('import("playwright")');
    expect(STATIC_IMPORT.test(source)).toBe(false);
  });

  test("loadSharp resolves a working encoder and caches the module", async () => {
    const sharp = await loadSharp();
    const encoded = await sharp({
      create: { width: 32, height: 24, channels: 3, background: "#102030" },
    })
      .webp({ quality: 60 })
      .toBuffer();
    const meta = await sharp(encoded).metadata();
    expect(meta.width).toBe(32);
    expect(meta.height).toBe(24);
    expect(await loadSharp()).toBe(sharp);
  });

  test("loadChromium resolves a launchable browser type and caches it", async () => {
    const chromium = await loadChromium();
    expect(typeof chromium.launch).toBe("function");
    expect(await loadChromium()).toBe(chromium);
  });
});
