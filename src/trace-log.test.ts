import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PATHS } from "./config.ts";

describe("trace logging controls", () => {
  const originalData = PATHS.data;

  afterEach(() => {
    PATHS.data = originalData;
  });

  test("keeps slow transcript pages while sampling fast pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "lfg-trace-"));
    PATHS.data = root;
    const module = await import(`./trace-log.ts?test=${Date.now()}`);
    module.traceLog("transcript_page", { durationMs: 1, marker: "fast" });
    module.traceLog("transcript_page", { durationMs: 300, marker: "slow" });
    await Bun.sleep(30);
    const file = join(root, "logs", readdirSync(join(root, "logs"))[0]);
    const logged = await Bun.file(file).text();
    expect(logged).not.toContain('"marker":"fast"');
    expect(logged).toContain('"marker":"slow"');
    rmSync(root, { recursive: true, force: true });
  });
});
