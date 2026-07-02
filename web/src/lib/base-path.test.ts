import { describe, expect, test } from "bun:test";

describe("base path helpers", () => {
  test("prefixes same-origin HTTP and WebSocket paths", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __LFG_BASE_PATH__: "/lfg/" },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:", host: "example.test" },
    });

    const { appPath, appWebSocketUrl, basePath } = await import("./base-path.ts");

    expect(basePath).toBe("/lfg/");
    expect(appPath("/")).toBe("/lfg/");
    expect(appPath("/api/sessions")).toBe("/lfg/api/sessions");
    expect(appPath("api/sessions")).toBe("/lfg/api/sessions");
    expect(appWebSocketUrl("/api/term?session=main")).toBe(
      "wss://example.test/lfg/api/term?session=main",
    );
  });
});
