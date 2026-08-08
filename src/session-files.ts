// Read-only filesystem browsing for a session's checkout, backing the Files
// panel (@pierre/trees for the tree, @pierre/diffs for the viewer/editor).
//
// Two shapes, both read-only. Nothing here writes: a user edit is delivered to
// the agent as a patch in a chat message, so the agent stays the single writer
// of its own worktree and there is no lock/mtime race to lose.
//
// @pierre/trees takes a FLAT path list and virtualizes rendering — it has no
// lazy per-directory loader. So the unit here is "every path under one root",
// and navigating up switches the root rather than extending the tree.

import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// Pierre's GitStatus vocabulary, which the tree renders as row badges.
export type TreeGitStatus = "added" | "deleted" | "ignored" | "modified" | "renamed" | "untracked";

export type TreeGitStatusEntry = { path: string; status: TreeGitStatus };

export type SessionTree = {
  ok: boolean;
  root: string;
  /** Highest browsable directory — the breadcrumb stops here. */
  ceiling: string;
  /** Parent directory, or null at the ceiling — drives the breadcrumb. */
  parent: string | null;
  /** Paths relative to `root`, POSIX-separated. Directories are implied. */
  paths: string[];
  gitStatus: TreeGitStatusEntry[];
  /** True when the walk hit MAX_PATHS and the listing is incomplete. */
  truncated: boolean;
  error?: string;
};

export type SessionFile = {
  /** Absolute path on disk. */
  path: string;
  /** Basename — @pierre/diffs infers the highlight language from it. */
  name: string;
  contents: string;
  size: number;
  binary: boolean;
  truncated: boolean;
};

// Browsing ceiling. Users can navigate up from a worktree to its siblings, but
// never above this. Reading is the dangerous direction on a server reachable
// over the network, so the ceiling is a hard wall rather than a default.
export const FILES_CEILING = resolve(process.env.LFG_FILES_CEILING ?? homedir());

const MAX_PATHS = 20_000;
const MAX_FILE_BYTES = 1_000_000;

// Directories that are never worth listing and would blow the path cap.
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__", ".cache"]);

// Secrets stay unreadable at every root, including inside the session's own
// checkout. A file browser that can serve ~/.ssh/id_ed25519 is a credential
// exfiltration endpoint wearing a UI.
const DENY_NAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pgpass",
  "credentials",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);
const DENY_DIRS = new Set([".aws", ".gnupg", ".ssh"]);
const DENY_PATTERNS = [/^\.env\./, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /^\.credentials\.json$/];

function isDeniedName(name: string): boolean {
  if (DENY_NAMES.has(name)) return true;
  return DENY_PATTERNS.some((re) => re.test(name));
}

/** True when any segment of `abs` is a denied file or directory. */
export function isDeniedPath(abs: string): boolean {
  const segments = abs.split(sep).filter(Boolean);
  const last = segments.length - 1;
  return segments.some((seg, i) => DENY_DIRS.has(seg) || (i === last && isDeniedName(seg)));
}

function withinCeiling(abs: string): boolean {
  return abs === FILES_CEILING || abs.startsWith(FILES_CEILING + sep);
}

/**
 * Resolve a browse target to an absolute path inside the ceiling, or null.
 * `target` may be absolute or relative to the session's cwd; `..` is resolved
 * before the check, so traversal cannot escape.
 */
export function resolveBrowsePath(cwd: string | null | undefined, target: string | null | undefined): string | null {
  const base = cwd ? resolve(cwd) : FILES_CEILING;
  const abs = target ? resolve(base, target) : base;
  if (!withinCeiling(abs)) return null;
  if (isDeniedPath(abs)) return null;
  return abs;
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString() };
}

function splitNul(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

function statusFromCode(code: string): TreeGitStatus | null {
  if (code === "??") return "untracked";
  if (code === "!!") return "ignored";
  const letters = code.replace(/\s/g, "");
  if (letters.includes("R")) return "renamed";
  if (letters.includes("A")) return "added";
  if (letters.includes("D")) return "deleted";
  if (letters.includes("M")) return "modified";
  return null;
}

// Git status for everything under `root`, keyed by root-relative path. Porcelain
// reports repo-root-relative paths regardless of -C, so each one is rebased onto
// `root` and dropped if it falls outside.
//
// `--untracked-files=all` matters: the default collapses a wholly-untracked
// directory to a single "videos/" entry, which would badge the folder row and
// leave every file the agent actually wrote unmarked.
function gitStatusUnder(root: string, repoRoot: string): TreeGitStatusEntry[] {
  const res = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (!res.ok) return [];
  const tokens = splitNul(res.out);
  const entries: TreeGitStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const raw = token.slice(3);
    // With -z a rename emits the new path in this token and the old path in the
    // next one; consume it so it is not parsed as its own status entry.
    if (code.replace(/\s/g, "").includes("R")) i++;
    const status = statusFromCode(code);
    if (!status) continue;
    const rel = toRelative(root, resolve(repoRoot, raw));
    if (rel) entries.push({ path: rel, status });
  }
  return entries;
}

function toRelative(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;
  return rel.split(sep).join("/");
}

// Tracked + untracked paths under `root`, straight from git. `git ls-files`
// scopes to the current directory and below, so running it in `root` already
// gives root-relative paths.
function gitPaths(root: string): { paths: string[]; truncated: boolean } {
  const tracked = git(root, ["ls-files", "-z"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const seen = new Set<string>();
  for (const p of [...splitNul(tracked.out), ...splitNul(untracked.out)]) {
    if (isDeniedPath(resolve(root, p))) continue;
    seen.add(p);
    if (seen.size >= MAX_PATHS) return { paths: [...seen], truncated: true };
  }
  return { paths: [...seen], truncated: false };
}

// Plain filesystem walk for roots outside a repo (or above one). Breadth-first
// so a truncated listing is still a usable top-level view rather than one deep
// spine, and capped so clicking up to a huge directory cannot hang the server.
function walkPaths(root: string): { paths: string[]; truncated: boolean } {
  const paths: string[] = [];
  const queue: string[] = [root];
  let truncated = false;

  while (queue.length) {
    const dir = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip rather than fail the whole tree
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || DENY_DIRS.has(entry.name))) continue;
      if (!entry.isDirectory() && isDeniedName(entry.name)) continue;
      if (entry.isSymbolicLink()) continue; // never follow links out of the ceiling
      const rel = toRelative(root, abs);
      if (!rel) continue;
      if (entry.isDirectory()) {
        queue.push(abs);
      } else {
        paths.push(rel);
        if (paths.length >= MAX_PATHS) return { paths, truncated: true };
      }
    }
  }
  return { paths, truncated };
}

function emptyTree(root: string, over: Partial<SessionTree> = {}): SessionTree {
  return {
    ok: true,
    root,
    ceiling: FILES_CEILING,
    parent: parentOf(root),
    paths: [],
    gitStatus: [],
    truncated: false,
    ...over,
  };
}

function parentOf(root: string): string | null {
  if (root === FILES_CEILING) return null;
  const up = dirname(root);
  return up !== root && withinCeiling(up) ? up : null;
}

/** Flat path listing for one root, plus git status badges when it is in a repo. */
export function listSessionTree(cwd: string | null | undefined, rootParam?: string | null): SessionTree {
  const root = resolveBrowsePath(cwd, rootParam ?? null);
  if (!root) return emptyTree(cwd ? resolve(cwd) : FILES_CEILING, { ok: false, error: "path outside the browsable root" });
  if (!existsSync(root)) return emptyTree(root, { ok: false, error: "directory not found" });

  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    return emptyTree(root, { ok: false, error: "directory not readable" });
  }
  if (!isDir) return emptyTree(root, { ok: false, error: "not a directory" });

  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  const repoRoot = topLevel.ok ? topLevel.out.trim() : "";

  const listing = repoRoot ? gitPaths(root) : walkPaths(root);
  // A repo whose listing is empty (an untracked-only subdirectory, say) still
  // has files worth showing — fall back to the plain walk.
  const paths = listing.paths.length ? listing.paths : walkPaths(root).paths;
  paths.sort((a, b) => a.localeCompare(b));

  return {
    ok: true,
    root,
    ceiling: FILES_CEILING,
    parent: parentOf(root),
    paths,
    gitStatus: repoRoot ? gitStatusUnder(root, repoRoot) : [],
    truncated: listing.truncated,
  };
}

// Heuristic binary sniff: a NUL byte in the first 8 KB. Cheap, and correct for
// every text format the editor can meaningfully open.
function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

/** One file's contents, shaped for @pierre/diffs' FileContents. */
export async function readSessionFile(
  cwd: string | null | undefined,
  target: string,
): Promise<SessionFile | { error: string }> {
  const abs = resolveBrowsePath(cwd, target);
  if (!abs) return { error: "path outside the browsable root" };
  if (!existsSync(abs)) return { error: "file not found" };

  let size = 0;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return { error: "path is a directory" };
    size = st.size;
  } catch {
    return { error: "file not readable" };
  }

  const file = Bun.file(abs);
  const head = new Uint8Array(await file.slice(0, Math.min(size, MAX_FILE_BYTES)).arrayBuffer());
  const binary = looksBinary(head);
  const truncated = size > MAX_FILE_BYTES;

  return {
    path: abs,
    name: basename(abs),
    contents: binary ? "" : new TextDecoder().decode(head),
    size,
    binary,
    truncated,
  };
}
