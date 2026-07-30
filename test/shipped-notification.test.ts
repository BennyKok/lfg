import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("shipped notifications", () => {
  test("queues a session deep link when a shipped post is accepted", async () => {
    const server = await readFile("src/commands/serve.ts", "utf8");
    expect(server).toContain("title: `Shipped: ${post.title}`");
    expect(server).toContain("`/?session=${encodeURIComponent(post.sessionId)}`");
    expect(server).toContain("user: notificationUser");
  });

  test("renders the exact queued notice and navigates an open PWA window", async () => {
    const worker = await readFile("web/public/sw.js", "utf8");
    expect(worker).toContain("const notification = asked?.notification || null");
    expect(worker).toContain("data: { url: notification.url || \"/\" }");
    expect(worker).toContain('if ("navigate" in client) await client.navigate(target)');
  });
});
