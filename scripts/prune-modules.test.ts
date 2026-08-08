import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldAllows, isIncompatible, prune, type Target } from "./prune-modules.ts";

const GLIBC_X64: Target = { os: "linux", cpu: "x64", libc: "glibc" };

describe("platform field matching", () => {
  test("an absent or empty list runs anywhere", () => {
    expect(fieldAllows(undefined, "linux")).toBe(true);
    expect(fieldAllows([], "linux")).toBe(true);
    expect(fieldAllows(null, "linux")).toBe(true);
  });

  test("a positive list is an allowlist", () => {
    expect(fieldAllows(["linux"], "linux")).toBe(true);
    expect(fieldAllows(["darwin", "win32"], "linux")).toBe(false);
  });

  test("negation excludes and permits the rest", () => {
    expect(fieldAllows(["!win32"], "linux")).toBe(true);
    expect(fieldAllows(["!linux"], "linux")).toBe(false);
  });

  test("negation wins over a positive entry", () => {
    expect(fieldAllows(["linux", "!linux"], "linux")).toBe(false);
  });
});

describe("incompatibility", () => {
  test("a plain package is kept", () => {
    expect(isIncompatible({}, GLIBC_X64)).toBe(false);
  });

  // The whole reason this script exists: Bun filters os and cpu but not libc,
  // so musl builds land on glibc hosts where they cannot execute.
  test("a musl build is incompatible with a glibc target", () => {
    expect(isIncompatible({ os: ["linux"], cpu: ["x64"], libc: ["musl"] }, GLIBC_X64)).toBe(true);
  });

  test("the matching glibc build is kept", () => {
    expect(isIncompatible({ os: ["linux"], cpu: ["x64"], libc: ["glibc"] }, GLIBC_X64)).toBe(false);
  });

  test("a package with no libc field is kept, not guessed at", () => {
    expect(isIncompatible({ os: ["linux"], cpu: ["x64"] }, GLIBC_X64)).toBe(false);
  });

  test("wrong os or cpu is incompatible", () => {
    expect(isIncompatible({ os: ["darwin"] }, GLIBC_X64)).toBe(true);
    expect(isIncompatible({ cpu: ["arm64"] }, GLIBC_X64)).toBe(true);
  });
});

function store(root: string, spec: string, name: string, manifest: Record<string, unknown>) {
  const dir = join(root, ".bun", spec, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
  writeFileSync(join(dir, "payload.bin"), "x".repeat(2048));
  return dir;
}

describe("pruning a bun store", () => {
  test("removes only incompatible packages and sweeps links to them", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-"));
    const modules = join(root, "node_modules");
    const musl = store(modules, "pkg-musl@1.0.0", "pkg-musl", { os: ["linux"], cpu: ["x64"], libc: ["musl"] });
    const gnu = store(modules, "pkg-gnu@1.0.0", "pkg-gnu", { os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
    const plain = store(modules, "plain@1.0.0", "plain", {});

    // Bun links to the store from the tree root; those links must not survive
    // the package they point at.
    symlinkSync(musl, join(modules, "pkg-musl"));
    symlinkSync(gnu, join(modules, "pkg-gnu"));
    symlinkSync(plain, join(modules, "plain"));

    const result = prune(modules, GLIBC_X64);

    expect(existsSync(musl)).toBe(false);
    expect(existsSync(gnu)).toBe(true);
    expect(existsSync(plain)).toBe(true);
    expect(result.removed.map(entry => entry.name.split("/").pop())).toEqual(["pkg-musl"]);
    expect(result.bytesFreed).toBeGreaterThan(2000);

    // The dangling link is gone; the live ones remain.
    const top = readdirSync(modules);
    expect(top).not.toContain("pkg-musl");
    expect(top).toContain("pkg-gnu");
    expect(result.linksSwept).toBe(1);
  });

  test("a dry run reports without deleting", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-dry-"));
    const modules = join(root, "node_modules");
    const musl = store(modules, "pkg-musl@1.0.0", "pkg-musl", { libc: ["musl"] });

    const result = prune(modules, GLIBC_X64, true);

    expect(existsSync(musl)).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(result.linksSwept).toBe(0);
  });

  test("scoped packages are found", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-scope-"));
    const modules = join(root, "node_modules");
    const scoped = join(modules, ".bun", "@img+sharp-musl@1.0.0", "node_modules", "@img", "sharp-musl");
    mkdirSync(scoped, { recursive: true });
    writeFileSync(join(scoped, "package.json"), JSON.stringify({ name: "@img/sharp-musl", libc: ["musl"] }));

    const result = prune(modules, GLIBC_X64);

    expect(existsSync(scoped)).toBe(false);
    expect(result.removed).toHaveLength(1);
  });

  test("targeting musl keeps musl and drops glibc", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-musl-"));
    const modules = join(root, "node_modules");
    const musl = store(modules, "pkg-musl@1.0.0", "pkg-musl", { libc: ["musl"] });
    const gnu = store(modules, "pkg-gnu@1.0.0", "pkg-gnu", { libc: ["glibc"] });

    prune(modules, { os: "linux", cpu: "x64", libc: "musl" });

    expect(existsSync(musl)).toBe(true);
    expect(existsSync(gnu)).toBe(false);
  });

  // A non-workspace `bun install --production` — which is exactly what the
  // release bundle ships — produces a hoisted tree with no .bun store at all.
  // Walking only the store silently pruned nothing here.
  test("prunes a hoisted tree that has no .bun store", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-hoisted-"));
    const modules = join(root, "node_modules");
    const hoist = (name: string, manifest: Record<string, unknown>) => {
      const dir = join(modules, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
      writeFileSync(join(dir, "payload.bin"), "x".repeat(4096));
      return dir;
    };
    const musl = hoist("opencode-linux-x64-musl", { os: ["linux"], cpu: ["x64"], libc: ["musl"] });
    const scopedMusl = hoist("@img/sharp-linuxmusl-x64", { libc: ["musl"] });
    const gnu = hoist("opencode-linux-x64", { os: ["linux"], cpu: ["x64"] });
    // A nested dependency of a kept package still gets inspected.
    const nested = join(modules, "opencode-linux-x64", "node_modules", "inner-musl");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "inner-musl", libc: ["musl"] }));

    const result = prune(modules, GLIBC_X64);

    expect(existsSync(musl)).toBe(false);
    expect(existsSync(scopedMusl)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(gnu)).toBe(true);
    expect(result.removed).toHaveLength(3);
  });

  test("an empty tree is a no-op rather than an error", () => {
    const root = mkdtempSync(join(tmpdir(), "prune-empty-"));
    const result = prune(join(root, "node_modules"), GLIBC_X64);
    expect(result.removed).toEqual([]);
    expect(result.bytesFreed).toBe(0);
  });
});
