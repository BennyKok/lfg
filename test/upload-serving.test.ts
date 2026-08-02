import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveUploadRequest, uploadsDir } from "../src/uploads";

describe("upload serving", () => {
  test("resolves an image inside the uploads dir", () => {
    const resolved = resolveUploadRequest("new-session-1754-ab12-CleanShot.png");
    expect(resolved).toEqual({
      filePath: join(tmpdir(), "lfg-uploads", "new-session-1754-ab12-CleanShot.png"),
      contentType: "image/png",
    });
    expect(uploadsDir()).toBe(join(tmpdir(), "lfg-uploads"));
  });

  test("maps the image extensions the transcript renders", () => {
    for (const [name, type] of [
      ["a.jpg", "image/jpeg"],
      ["a.JPEG", "image/jpeg"],
      ["a.webp", "image/webp"],
      ["a.gif", "image/gif"],
    ] as const) {
      expect(resolveUploadRequest(name)).toMatchObject({ contentType: type });
    }
  });

  test("refuses anything that isn't a displayable image", () => {
    expect(resolveUploadRequest("secrets.pdf")).toEqual({
      error: "unsupported upload type",
      status: 415,
    });
    expect(resolveUploadRequest("noext")).toMatchObject({ status: 415 });
  });

  test("refuses traversal, separators and encoded escapes", () => {
    for (const name of [
      "..%2F..%2Fetc%2Fpasswd.png",
      "../../etc/passwd.png",
      "..%2Fshadow.png",
      "sub/dir.png",
      "%2Fetc%2Fhosts.png",
      "..png..%2F..%2Fa.png",
      "",
      `${"a".repeat(300)}.png`,
    ]) {
      expect(resolveUploadRequest(name)).toMatchObject({ status: 400 });
    }
  });

  test("refuses a malformed percent-encoding instead of throwing", () => {
    expect(resolveUploadRequest("%E0%A4%A.png")).toEqual({
      error: "invalid upload name",
      status: 400,
    });
  });

  test("the route serves uploads with a nosniff, no-execute posture", async () => {
    const server = await readFile("src/commands/serve.ts", "utf8");
    const start = server.indexOf('path.match(/^\\/api\\/uploads\\/([^/]+)$/)');
    expect(start).toBeGreaterThan(-1);
    const route = server.slice(start, start + 2200);
    expect(route).toContain("resolveUploadRequest");
    expect(route).toContain('"X-Content-Type-Options": "nosniff"');
    expect(route).toContain("default-src 'none'; sandbox");
    expect(route).toContain("getOrCreateImagePreview");
  });
});
