import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("shipped notifications", () => {
  test("queues a session deep link when a shipped post is accepted", async () => {
    const server = await readFile("src/commands/serve.ts", "utf8");
    expect(server).toContain("title: `Shipped: ${post.title}`");
    expect(server).toContain("`/?session=${encodeURIComponent(post.sessionId)}`");
    expect(server).toContain('"/notifications"');
    expect(server).toContain("user: notificationUser");
  });

  // A ship with closeSession:true schedules the session's teardown ~1.5s after
  // the push is queued, so by the time anyone taps the notification the id is
  // legitimately gone from the live fleet. The deep-link resolver only searched
  // live sessions and then gave up with "That session is no longer running" —
  // firing on the single most common shipped tap, while the notification body
  // said "Tap to review the finished session."
  test("opens a shipped deep link as a finished session instead of erroring", async () => {
    const app = await readFile("web/src/App.tsx", "utf8");
    expect(app).not.toContain("That session is no longer running");
    // Falls back to the same historical review the in-app Shipped row opens.
    expect(app).toContain("reviewLabel: post ? \"Shipped\" : \"Finished\"");
    expect(app).toContain("openHistoricalSession({");
    // Dual-id backends post under whichever id the ship carried; every sibling
    // lookup already matched both, so the deep link must too.
    expect(app).toContain(
      "(session) => session.sessionId === sid || session.nativeSessionId === sid,",
    );
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
    expect(worker).toContain("await showOmgNotification(notification.title");
  });

  test("acknowledges OS notifications from the Notification Center", async () => {
    const push = await readFile("web/src/lib/push.ts", "utf8");
    const main = await readFile("web/src/main.tsx", "utf8");
    const worker = await readFile("web/public/sw.js", "utf8");
    // The shipped feed lives in its own lazily loaded chunk now; these
    // assertions are about the notification surface, wherever it renders from.
    const app =
      (await readFile("web/src/App.tsx", "utf8")) +
      (await readFile("web/src/views/shipped-page.tsx", "utf8"));
    expect(push).toContain("export async function acknowledgePushNotifications()");
    expect(push).toContain("notification.close()");
    expect(push).toContain("clearAppBadge");
    expect(app).toContain("const markAllRead = async () =>");
    expect(app).toContain("await acknowledgePushNotifications()");
    expect(app).toContain("Mark all read");
    expect(app).toContain("Notifications marked read");
    expect(main).not.toContain("acknowledgePushNotifications");
    expect(worker).not.toContain("LFG_PUSH_DISPLAYED");
    expect(app).not.toContain("Clear dot");
    expect(app).toContain('title="Mark all read — clears the app icon badge"');
  });
});
