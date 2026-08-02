import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function piPackageName(): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const names = Object.keys(manifest.dependencies ?? {}).filter((n) => n.endsWith("/pi-coding-agent"));
  expect(names).toHaveLength(1);
  return names[0];
}

// The pi CLI is located by hand-built path fragments in two places —
// resolvePiCliPath() in the harness and piPath() in agent detection — because
// the RPC backend spawns LFG's own bundled copy rather than a global binary.
// Neither is a plain import, so a package rename does not break the build: pi
// just quietly reports as unavailable and every pi session fails to start.
//
// That is not hypothetical. During the @mariozechner -> @earendil-works
// migration both fragments survived the first sweep, because the greps used to
// find call sites filtered out `node_modules` — and both lines contain the
// literal string "node_modules". Assert the wiring instead of trusting a grep.
test("the bundled pi CLI path tracks the pinned package name", () => {
  const pkg = piPackageName();
  const [scope, name] = pkg.split("/");

  const harness = readFileSync(join(REPO_ROOT, "src/agents/backends/pi-session.ts"), "utf8");
  expect(harness).toContain(`node_modules/${pkg}/dist/cli.js`);

  const detection = readFileSync(join(REPO_ROOT, "src/coding-agents.ts"), "utf8");
  expect(detection).toContain(`"node_modules", "${scope}", "${name}", "dist", "cli.js"`);
});

test("the pinned pi package is actually installed and exposes the CLI entry", () => {
  const pkg = piPackageName();
  const cli = join(REPO_ROOT, "node_modules", pkg, "dist", "cli.js");
  // Skip rather than fail in a checkout with no install — CI installs first,
  // and a false red here would say nothing about the code.
  if (!existsSync(join(REPO_ROOT, "node_modules"))) return;
  expect(existsSync(cli)).toBe(true);
});

test("no deprecated @mariozechner pi package is still depended on", () => {
  // The deprecated packages are unmaintained and carry GHSA-jfgx-wxx8-mp94 with
  // no possible fix. scripts/audit*.ts may name them — that is the advisory
  // being documented, not a dependency.
  const manifests = ["package.json", ...readdirSync(join(REPO_ROOT, "packages")).map((d) => `packages/${d}/package.json`)];
  for (const rel of manifests) {
    const path = join(REPO_ROOT, rel);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string>>;
    for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(manifest[section] ?? {})) {
        expect(dep.startsWith("@mariozechner/pi-")).toBe(false);
      }
    }
  }
});
