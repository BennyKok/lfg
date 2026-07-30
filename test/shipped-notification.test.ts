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

  test("keeps the installed PWA badge in sync with visible notifications", async () => {
    const worker = await readFile("web/public/sw.js", "utf8");
    expect(worker).toContain("async function syncAppBadge()");
    expect(worker).toContain("await self.navigator.setAppBadge(visible.length)");
    expect(worker).toContain("await self.navigator.clearAppBadge()");
    expect(worker).toContain("await showLfgNotification(notification.title");
  });

  test("lets the user clear handled PWA notifications and their app badge", async () => {
    const push = await readFile("web/src/lib/push.ts", "utf8");
    const app = await readFile("web/src/App.tsx", "utf8");
    expect(push).toContain("export async function clearPushNotificationBadge()");
    expect(push).toContain("notification.close()");
    expect(push).toContain("clearAppBadge");
    expect(app).toContain("Clear dot");
    expect(app).toContain("Mark visible notifications as handled");
  });
});
