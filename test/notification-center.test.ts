import { describe, expect, test } from "bun:test";
import {
  notificationIsUnread,
  shippedNotificationId,
  type NotificationReadState,
} from "../web/src/lib/notification-center";

describe("notification center read state", () => {
  test("gives each shipped revision a stable notification id", () => {
    expect(shippedNotificationId({ id: "post-a", rev: 3 })).toBe("shipped:post-a:3");
  });

  test("treats items after the read cursor as unread", () => {
    const state: NotificationReadState = { through: 100, ids: [] };
    expect(notificationIsUnread(state, { id: "shipped:a:1", ts: 101 })).toBe(true);
    expect(notificationIsUnread(state, { id: "shipped:a:1", ts: 100 })).toBe(false);
  });

  test("supports marking one newer item read without clearing its neighbors", () => {
    const state: NotificationReadState = {
      through: 100,
      ids: ["shipped:a:1"],
    };
    expect(notificationIsUnread(state, { id: "shipped:a:1", ts: 200 })).toBe(false);
    expect(notificationIsUnread(state, { id: "shipped:b:1", ts: 200 })).toBe(true);
  });
});
