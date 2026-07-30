import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

describe("startup shell", () => {
  test("renders the real app while bootstrap is pending", () => {
    expect(app).not.toContain("if (loading) {\n    return <AppShellSkeleton />;");
    expect(app).toContain('data-startup-state={loading ? "connecting" : "ready"}');
  });

  test("temporarily disables the shell and exposes connection status", () => {
    expect(app).toContain("inert={loading}");
    expect(app).toContain("aria-busy={loading}");
    expect(app).toContain("{loading ? <AppStartupStatus /> : null}");
    expect(app).toContain("Connecting…");
  });
});
