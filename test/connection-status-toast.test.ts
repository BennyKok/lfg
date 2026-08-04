import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("one physical reconnect owns one toast across embedded surfaces", async () => {
  const source = await readFile("web/src/ConnectionStatus.tsx", "utf8");
  expect(source).toContain('toast.loading("Reconnecting…", { id: WS_TOAST_ID })');
  expect(source).toContain('toast.success("Reconnected", { id: WS_TOAST_ID, duration: 2000 })');
  expect(source).not.toContain('toast.success("Reconnected", { duration: 2000 })');
});
