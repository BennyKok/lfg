// Bootstrap gathers its data into a `tasks` object and then hand-writes the
// response from named fields. Adding a task is therefore only half the job:
// the work runs, the result is discarded, and the client sees nothing — with
// no error anywhere. That happened to `localUrl` in this very session, and the
// identical shape had just been fixed in setGlobalSettings, which also writes
// an explicit key list.
//
// So: every key gathered must appear in the response.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVE = readFileSync(join(import.meta.dir, "..", "src", "commands", "serve.ts"), "utf8");

function bootstrapBlock(): string {
  const start = SERVE.indexOf('if (path === "/api/bootstrap"');
  expect(start, "bootstrap handler not found").toBeGreaterThanOrEqual(0);
  const end = SERVE.indexOf('Cache-Control": "no-cache"', start);
  expect(end, "end of bootstrap handler not found").toBeGreaterThan(start);
  return SERVE.slice(start, end);
}

describe("the bootstrap payload", () => {
  test("every gathered task reaches the response", () => {
    const block = bootstrapBlock();
    const tasksStart = block.indexOf("const tasks = {");
    const tasksEnd = block.indexOf("};", tasksStart);
    const taskKeys = [...block.slice(tasksStart, tasksEnd).matchAll(/^\s{10}(\w+):/gm)]
      .map(m => m[1]);
    expect(taskKeys.length).toBeGreaterThan(5);

    const response = block.slice(block.indexOf("return json("));
    for (const key of taskKeys) {
      // autoAgents and findings are nested under `auto`, so accept either the
      // bare key or a `boot.<key>` reference inside the response object.
      expect(response, `bootstrap gathers "${key}" but never returns it`)
        .toContain(`boot.${key}`);
    }
  });
});
