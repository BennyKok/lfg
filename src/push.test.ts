import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import {
  queuePushNotification,
  saveSubscription,
  takePushNotification,
} from "./push.ts";

const realData = PATHS.data;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lfg-push-"));
  PATHS.data = dir;
});

afterEach(async () => {
  PATHS.data = realData;
  await rm(dir, { recursive: true, force: true });
});

describe("event-specific push notifications", () => {
  test("queues shipped notices only for the assigned user's devices", async () => {
    await saveSubscription({ endpoint: "https://push.test/benny", user: "benny@example.com" });
    await saveSubscription({ endpoint: "https://push.test/angel", user: "angel@example.com" });

    await queuePushNotification(
      {
        title: "Shipped: Faster search",
        body: "Results now appear instantly.",
        url: "/?session=session-123",
        tag: "shipped-post-1",
      },
      { user: "benny@example.com" },
    );

    expect(await takePushNotification("https://push.test/benny")).toEqual({
      title: "Shipped: Faster search",
      body: "Results now appear instantly.",
      url: "/?session=session-123",
      tag: "shipped-post-1",
    });
    expect(await takePushNotification("https://push.test/benny")).toBeNull();
    expect(await takePushNotification("https://push.test/angel")).toBeNull();
  });

  test("preserves delivery order and pending notices across subscription refresh", async () => {
    const endpoint = "https://push.test/device";
    await saveSubscription({ endpoint, user: "benny@example.com" });
    await queuePushNotification({ title: "First", url: "/?session=one" });
    await queuePushNotification({ title: "Second", url: "/?session=two" });
    await saveSubscription({ endpoint, user: "benny@example.com", keys: { auth: "refreshed" } });

    expect((await takePushNotification(endpoint))?.url).toBe("/?session=one");
    expect((await takePushNotification(endpoint))?.url).toBe("/?session=two");
    expect(await takePushNotification(endpoint)).toBeNull();
  });
});
