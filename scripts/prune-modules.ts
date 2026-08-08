#!/usr/bin/env bun
/**
 * Remove packages from an installed node_modules tree that cannot run on the
 * target platform, then sweep the symlinks left pointing at them.
 *
 * Why this exists: npm expresses platform gating with the `os`, `cpu`, and
 * `libc` manifest fields, and Bun honours `os` and `cpu` when it resolves
 * optionalDependencies — but not `libc`. So every glibc Linux install also
 * downloads the musl builds of opencode, the Claude agent SDK, sharp's libvips,
 * and friends. On this dependency graph that is ~556 MB that physically cannot
 * execute on the target. There is no `bun install --libc` to opt out of it.
 *
 * Releases use this to ship a per-platform bundle whose node_modules is already
 * correct for the machine downloading it, which is also what lets setup.sh skip
 * `bun install` entirely.
 *
 * Usage:
 *   bun run scripts/prune-modules.ts --root <dir> [--os linux] [--cpu x64]
 *                                    [--libc glibc] [--dry-run] [--quiet]
 */
import { readdirSync, readFileSync, realpathSync, rmSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";

export type Target = { os: string; cpu: string; libc: string };

/**
 * npm platform-field semantics: a list of allowed values, where a leading `!`
 * negates. An absent or empty list means "runs anywhere". Negation wins, so
 * ["!win32"] excludes exactly one platform and permits the rest.
 */
export function fieldAllows(field: unknown, value: string): boolean {
  if (!Array.isArray(field) || field.length === 0) return true;
  const entries = field.filter((entry): entry is string => typeof entry === "string");
  if (entries.length === 0) return true;
  const negated = entries.filter(entry => entry.startsWith("!")).map(entry => entry.slice(1));
  if (negated.includes(value)) return false;
  const positive = entries.filter(entry => !entry.startsWith("!"));
  if (positive.length === 0) return true;
  return positive.includes(value) || positive.includes("any");
}

export type Manifest = { os?: unknown; cpu?: unknown; libc?: unknown };

/** True when a manifest's declared platform gating excludes the target. */
export function isIncompatible(manifest: Manifest, target: Target): boolean {
  return (
    !fieldAllows(manifest.os, target.os) ||
    !fieldAllows(manifest.cpu, target.cpu) ||
    !fieldAllows(manifest.libc, target.libc)
  );
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      // Symlinks are counted where their target lives, never through the link,
      // or shared store entries would be tallied once per linking package.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      try {
        total += statSync(path).size;
      } catch {
        /* raced away */
      }
    }
  }
  return total;
}

/**
 * Every real package directory in an install tree.
 *
 * Two layouts have to work. Bun's isolated layout (what a workspace root gets)
 * keeps one copy per resolution under `.bun/<name>@<version>/node_modules/<name>`
 * and links to it from everywhere else. Bun's hoisted layout — which is what a
 * non-workspace `bun install --production` produces, and therefore what the
 * release bundle actually ships — has no `.bun` at all and puts packages
 * directly in the tree, with nested node_modules for conflicting versions.
 *
 * Handling only the store silently pruned nothing on hoisted trees, so walk
 * both. Symlinked entries are skipped: the real directory is visited once,
 * wherever it actually lives.
 */
function packageDirs(root: string): string[] {
  const found: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const modules = queue.pop()!;
    let entries;
    try {
      entries = readdirSync(modules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      const path = join(modules, entry.name);

      // `.bun/<spec>/node_modules/…` is another node_modules to walk.
      if (entry.name === ".bun") {
        let specs: string[];
        try {
          specs = readdirSync(path);
        } catch {
          continue;
        }
        for (const spec of specs) queue.push(join(path, spec, "node_modules"));
        continue;
      }
      if (entry.name.startsWith(".")) continue;

      // A scope directory holds packages, and is not one itself.
      if (entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const inner of scoped) {
          if (inner.isSymbolicLink() || !inner.isDirectory()) continue;
          const scopedPath = join(path, inner.name);
          found.push(scopedPath);
          queue.push(join(scopedPath, "node_modules"));
        }
        continue;
      }

      found.push(path);
      queue.push(join(path, "node_modules"));
    }
  }
  return found;
}

function readManifest(dir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Remove links whose target no longer exists, which pruning necessarily creates. */
function sweepDanglingLinks(root: string): number {
  let removed = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          realpathSync(path);
        } catch {
          rmSync(path, { force: true });
          removed += 1;
        }
        continue;
      }
      if (entry.isDirectory()) stack.push(path);
    }
  }
  return removed;
}

export type PruneResult = {
  removed: { name: string; bytes: number }[];
  bytesFreed: number;
  linksSwept: number;
};

export function prune(root: string, target: Target, dryRun = false): PruneResult {
  const removed: { name: string; bytes: number }[] = [];
  let bytesFreed = 0;
  for (const dir of packageDirs(root)) {
    let real: string;
    try {
      // Never follow a link out of the store and delete somebody else's copy.
      if (lstatSync(dir).isSymbolicLink()) continue;
      real = dir;
    } catch {
      continue;
    }
    const manifest = readManifest(real);
    if (!manifest) continue;
    if (!isIncompatible(manifest, target)) continue;
    const bytes = dirSize(real);
    removed.push({ name: real.slice(root.length + 1), bytes });
    bytesFreed += bytes;
    if (!dryRun) rmSync(real, { recursive: true, force: true });
  }
  const linksSwept = dryRun ? 0 : sweepDanglingLinks(root);
  return { removed, bytesFreed, linksSwept };
}

function arg(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const root = arg(argv, "root", "node_modules");
  const target: Target = {
    os: arg(argv, "os", process.platform),
    cpu: arg(argv, "cpu", process.arch),
    // glibc unless told otherwise: setup.sh targets Debian/Ubuntu and macOS,
    // and a musl target would want the mirror image of this prune.
    libc: arg(argv, "libc", "glibc"),
  };
  const dryRun = argv.includes("--dry-run");
  const quiet = argv.includes("--quiet");

  const result = prune(root, target, dryRun);
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (!quiet) {
    for (const entry of [...result.removed].sort((a, b) => b.bytes - a.bytes).slice(0, 12)) {
      process.stdout.write(`  ${dryRun ? "would remove" : "removed"} ${entry.name} (${mb(entry.bytes)})\n`);
    }
  }
  process.stdout.write(
    `${dryRun ? "Would free" : "Freed"} ${mb(result.bytesFreed)} across ${result.removed.length} packages ` +
      `for ${target.os}/${target.cpu}/${target.libc}` +
      (dryRun ? "\n" : ` (${result.linksSwept} dangling links swept)\n`),
  );
}
