import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { createOriginDelivery, listOriginDeliveries } from "./origin-deliveries.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

describe("origin deliveries", () => {
  const originalData = PATHS.data;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lfg-origin-delivery-"));
    PATHS.data = join(root, "data");
  });

  afterEach(() => {
    PATHS.data = originalData;
    rmSync(root, { recursive: true, force: true });
  });

  test("persists a session-scoped channel-neutral delivery", () => {
    const delivery = createOriginDelivery({
      sessionId: SESSION,
      text: "here is the result",
      media: [{ path: "/api/artifacts/shot-1", kind: "image", mimeType: "image/png" }],
      now: 100,
    });
    expect(delivery.target).toBe("origin");
    expect(listOriginDeliveries(SESSION)).toEqual([delivery]);
    expect(listOriginDeliveries("22222222-2222-4222-8222-222222222222")).toEqual([]);
  });

  test("dedupes a transport retry without suppressing a later intentional send", () => {
    const input = { sessionId: SESSION, text: "same update" };
    const first = createOriginDelivery({ ...input, now: 100 });
    const retry = createOriginDelivery({ ...input, now: 101 });
    const later = createOriginDelivery({ ...input, now: 31_001 });
    expect(retry.id).toBe(first.id);
    expect(later.id).not.toBe(first.id);
  });
});
