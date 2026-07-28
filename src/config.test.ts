import { describe, expect, test } from "bun:test";
import { localServeHost } from "./config.ts";

describe("localServeHost", () => {
  test("folds wildcard bind addresses back to loopback", () => {
    // Every containerized deploy sets LFG_HOST to one of these. `0.0.0.0` only
    // connects by accident on Linux; `::` does not survive URL parsing at all.
    expect(localServeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(localServeHost("::")).toBe("[::1]");
    expect(localServeHost("[::]")).toBe("[::1]");
  });

  test("brackets bare IPv6 literals so they parse as a URL authority", () => {
    expect(localServeHost("::1")).toBe("[::1]");
    expect(localServeHost("fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1]");
    expect(() => new URL(`http://${localServeHost("::1")}:8766`)).not.toThrow();
    expect(() => new URL(`http://${localServeHost("::")}:8766`)).not.toThrow();
  });

  test("leaves an already-bracketed literal alone", () => {
    expect(localServeHost("[fd7a:115c:a1e0::1]")).toBe("[fd7a:115c:a1e0::1]");
  });

  test("passes through routable hosts untouched", () => {
    expect(localServeHost("127.0.0.1")).toBe("127.0.0.1");
    expect(localServeHost("192.168.1.10")).toBe("192.168.1.10");
    expect(localServeHost("box.tailnet.ts.net")).toBe("box.tailnet.ts.net");
  });

  test("defaults to loopback when unset, empty, or whitespace", () => {
    expect(localServeHost(undefined)).toBe("127.0.0.1");
    expect(localServeHost("")).toBe("127.0.0.1");
    expect(localServeHost("  ")).toBe("127.0.0.1");
    expect(localServeHost("  0.0.0.0  ")).toBe("127.0.0.1");
  });
});
