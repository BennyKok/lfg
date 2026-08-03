import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const server = readFileSync("src/commands/serve.ts", "utf8");

describe("session continue endpoint", () => {
  test("creates the replacement before archiving the source", () => {
    const routeStart = server.indexOf(
      'path.match(/^\\/api\\/sessions\\/([0-9a-fA-F-]{36})\\/fork$/)',
    );
    const routeEnd = server.indexOf('if (path === "/api/sessions/new"', routeStart);
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = server.slice(routeStart, routeEnd);

    const createAt = route.indexOf('fetch(`http://127.0.0.1:${PORT}/api/sessions/new`');
    const successGuardAt = route.indexOf("if (r.ok && body?.archiveSource === true)");
    const archiveAt = route.indexOf("await closeLiveSession(");
    expect(createAt).toBeGreaterThan(-1);
    expect(successGuardAt).toBeGreaterThan(createAt);
    expect(archiveAt).toBeGreaterThan(successGuardAt);
    expect(route).toContain('source: "session_continue"');
    expect(route).toContain("sourceArchived");
  });

  test("passes the source title to the replacement session only when continuing", () => {
    const routeStart = server.indexOf(
      'path.match(/^\\/api\\/sessions\\/([0-9a-fA-F-]{36})\\/fork$/)',
    );
    const routeEnd = server.indexOf('if (path === "/api/sessions/new"', routeStart);
    const route = server.slice(routeStart, routeEnd);

    expect(route).toContain("title: body?.archiveSource === true ? title : undefined");
  });

  test("uses an explicit inherited title instead of deriving one from the handoff prompt", () => {
    const routeStart = server.indexOf('if (path === "/api/sessions/new"');
    const route = server.slice(routeStart);

    expect(route).toContain("const requestedTitle = body?.title?.trim().slice(0, 200)");
    expect(route).toContain("title: requestedTitle || body?.prompt?.slice(0, 72)");
  });
});
