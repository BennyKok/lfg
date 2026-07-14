import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeEnvValue } from "./voice-providers.ts";

let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("writeEnvValue", () => {
  test("replaces an existing value while preserving surrounding lines", async () => {
    dir = await mkdtemp(join(tmpdir(), "lfg-voice-env-"));
    const file = join(dir, ".env");
    await writeFile(file, "# voice\nELEVENLABS_API_KEY=old\nOPENAI_API_KEY=keep\n", { mode: 0o640 });

    await writeEnvValue(file, "ELEVENLABS_API_KEY", "new_key-123");

    expect(await readFile(file, "utf8")).toBe(
      "# voice\nELEVENLABS_API_KEY=new_key-123\nOPENAI_API_KEY=keep\n",
    );
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  test("appends a missing value and creates new files private", async () => {
    dir = await mkdtemp(join(tmpdir(), "lfg-voice-env-"));
    const existing = join(dir, "existing.env");
    await writeFile(existing, "OTHER=value");
    await writeEnvValue(existing, "ELEVENLABS_API_KEY", "key");
    expect(await readFile(existing, "utf8")).toBe("OTHER=value\nELEVENLABS_API_KEY=key");

    const created = join(dir, "created.env");
    await writeEnvValue(created, "ELEVENLABS_API_KEY", "key");
    expect(await readFile(created, "utf8")).toBe("ELEVENLABS_API_KEY=key");
    expect((await stat(created)).mode & 0o777).toBe(0o600);
  });
});
