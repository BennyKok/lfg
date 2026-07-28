// Compute a structured diff for a session's worktree, for the chat "diffs for
// review" hover bar + viewer. Shows everything the session changed relative to
// where its branch forked from origin/main: committed branch work + uncommitted
// tracked changes (via `git diff <merge-base>`) plus untracked files. Read-only:
// never touches the index or working tree (sibling agents are live in it).

import { basename, dirname, resolve } from "node:path";
import { WORKTREE_ROOT } from "./worktree.ts";

export type DiffLineKind = "add" | "del" | "context" | "meta";

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = {
  header: string;
  lines: DiffLine[];
};

export type DiffFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  truncated?: boolean;
};

export type SessionDiff = {
  ok: boolean;
  isWorktree: boolean;
  merged: boolean;
  branch: string | null;
  base: string | null; // short sha of the fork point
  files: DiffFile[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean;
  fetchWarning?: string;
  error?: string;
};

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2_000_000; // cap patch text we parse, per request
const MAX_UNTRACKED_BYTES = 200_000; // don't inline giant untracked blobs
const MERGE_CACHE_MISS_MS = 30_000;
const MERGE_CACHE_HIT_MS = 5 * 60_000;
const mergeCache = new Map<string, { merged: boolean; checkedAt: number }>();

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string; code: number } {
  const proc = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  return {
    ok: proc.exitCode === 0,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
    code: proc.exitCode ?? -1,
  };
}

export function isSessionWorktree(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const abs = resolve(cwd);
  return abs === resolve(WORKTREE_ROOT) || abs.startsWith(resolve(WORKTREE_ROOT) + "/");
}

function emptyDiff(over: Partial<SessionDiff> = {}): SessionDiff {
  return {
    ok: true,
    isWorktree: false,
    merged: false,
    branch: null,
    base: null,
    files: [],
    totals: { files: 0, additions: 0, deletions: 0 },
    truncated: false,
    ...over,
  };
}

// Parse `git diff` unified output into structured files/hunks.
function parseUnifiedDiff(patch: string): Map<string, DiffFile> {
  const byPath = new Map<string, DiffFile>();
  const lines = patch.split("\n");
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (cur) byPath.set(cur.path, cur);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { path: "", status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
      hunk = null;
      // "diff --git a/x b/y" — fall back to the b/ path; refined by ---/+++ below.
      const m = line.match(/ b\/(.+)$/);
      if (m) cur.path = m[1];
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ")) {
      cur.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null" && p.startsWith("a/")) cur.oldPath = cur.oldPath ?? p.slice(2);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null" && p.startsWith("b/")) cur.path = p.slice(2);
    } else if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith("+")) {
        cur.additions++;
        hunk.lines.push({ kind: "add", text: line.slice(1), newLine: newNo++ });
      } else if (line.startsWith("-")) {
        cur.deletions++;
        hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldNo++ });
      } else if (line.startsWith("\\")) {
        hunk.lines.push({ kind: "meta", text: line.slice(1).trim() });
      } else {
        // context (leading space) or blank
        hunk.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine: oldNo++, newLine: newNo++ });
      }
    }
  }
  flush();
  return byPath;
}

function collectUntracked(cwd: string, existing: Set<string>): DiffFile[] {
  const r = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!r.ok) return [];
  const paths = r.out.split("\0").map((p) => p.trim()).filter(Boolean);
  const files: DiffFile[] = [];
  for (const path of paths) {
    if (existing.has(path)) continue;
    let text = "";
    let binary = false;
    let truncated = false;
    try {
      const buf = Bun.spawnSync({ cmd: ["git", "-C", cwd, "diff", "--no-color", "--no-index", "--", "/dev/null", path], stdout: "pipe", stderr: "pipe" }).stdout.toString();
      if (buf.length > MAX_UNTRACKED_BYTES) {
        truncated = true;
        text = buf.slice(0, MAX_UNTRACKED_BYTES);
      } else {
        text = buf;
      }
      binary = /Binary files /.test(buf);
    } catch {
      // ignore unreadable file
    }
    const parsed = binary ? null : parseUnifiedDiff(text).get(path);
    files.push({
      path,
      status: "untracked",
      additions: parsed?.additions ?? 0,
      deletions: 0,
      binary,
      hunks: parsed?.hunks ?? [],
      truncated: truncated || parsed?.truncated,
    });
  }
  return files;
}

// Main entry: compute the structured diff for a worktree checkout at `cwd`.
export function computeSessionDiff(cwd: string | null | undefined): SessionDiff {
  if (!isSessionWorktree(cwd)) return emptyDiff({ isWorktree: false });
  const wt = resolve(cwd!);

  const head = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return emptyDiff({ isWorktree: true, ok: false, error: "not a git checkout" });
  const branch = head.out.trim() || `session_${basename(wt)}`;

  const fetchWarning = originMainWarning(wt);
  const base = forkBase(wt);

  // Everything different from the fork point: committed branch work +
  // uncommitted tracked changes, in one coherent patch.
  const diff = git(wt, ["diff", "--no-color", "-M", base]);
  let patch = diff.out;
  let truncated = false;
  if (patch.length > MAX_TOTAL_BYTES) {
    patch = patch.slice(0, MAX_TOTAL_BYTES);
    truncated = true;
  }

  const byPath = parseUnifiedDiff(patch);
  const tracked = [...byPath.values()];
  const untracked = collectUntracked(wt, new Set(byPath.keys()));

  let files = [...tracked, ...untracked];
  if (files.length > MAX_FILES) {
    files = files.slice(0, MAX_FILES);
    truncated = true;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totals = files.reduce(
    (acc, f) => {
      acc.files++;
      acc.additions += f.additions;
      acc.deletions += f.deletions;
      return acc;
    },
    { files: 0, additions: 0, deletions: 0 },
  );

  return {
    ok: true,
    isWorktree: true,
    merged: branchMergedIntoMain(wt),
    branch,
    base: base.slice(0, 12),
    files,
    totals,
    truncated,
    fetchWarning,
  };
}

// Fork point: the merge-base against the *local* origin/main ref. We do NOT
// `git fetch` here — the diff shows changes vs where the branch forked, which
// is a stable ancestor commit that doesn't move as origin/main advances. A
// network fetch on this hot path (the bar polls every 8s) was the source of the
// perceived slowness. Remote freshness only matters for the brain merge-guard's
// "commits ahead" count, which does its own fetch on a slow (hourly) cadence.
function forkBase(wt: string): string {
  const mb = git(wt, ["merge-base", "origin/main", "HEAD"]);
  return mb.ok ? mb.out.trim() : "origin/main";
}

function originMainWarning(wt: string): string | undefined {
  const ok = git(wt, ["rev-parse", "--verify", "--quiet", "origin/main"]).ok;
  return ok ? undefined : "origin/main not found locally — diff is vs HEAD's initial commit";
}

// A branch is only fully merged when its committed HEAD is contained in main
// and no tracked/untracked work remains on top. The clean-worktree guard keeps
// a session that made new edits after merging in the normal "Review" state.
function branchMergedIntoMain(wt: string): boolean {
  const status = git(wt, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!status.ok || status.out.trim() !== "") return false;

  const local = git(wt, ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  if (local.ok) return true;

  // origin/main intentionally stays unfetched on this hot path, so a just-
  // merged GitHub PR can precede the local remote-tracking ref. Ask `gh` as a
  // cached fallback; misses refresh quickly enough for the 8s UI poll while a
  // confirmed merge remains stable.
  const head = git(wt, ["rev-parse", "HEAD"]);
  const branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok || !branch.ok || branch.out.trim() === "HEAD") return false;
  const key = `${wt}:${head.out.trim()}`;
  const cached = mergeCache.get(key);
  const now = Date.now();
  const ttl = cached?.merged ? MERGE_CACHE_HIT_MS : MERGE_CACHE_MISS_MS;
  if (cached && now - cached.checkedAt < ttl) return cached.merged;

  let merged = false;
  try {
    const pr = Bun.spawnSync({
      cmd: ["gh", "pr", "view", branch.out.trim(), "--json", "state,headRefOid"],
      cwd: wt,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pr.exitCode === 0) {
      const data = JSON.parse(pr.stdout.toString()) as { state?: string; headRefOid?: string };
      merged = data.state?.toUpperCase() === "MERGED" && data.headRefOid === head.out.trim();
    }
  } catch {
    // `gh` is optional. Local ancestry remains the source of truth when it is
    // unavailable or the repository is not connected to GitHub.
  }
  mergeCache.set(key, { merged, checkedAt: now });
  if (mergeCache.size > 500) {
    for (const [cacheKey, entry] of mergeCache) {
      if (now - entry.checkedAt > MERGE_CACHE_HIT_MS) mergeCache.delete(cacheKey);
    }
  }
  return merged;
}

function statusFromLetter(letter: string): DiffFileStatus {
  if (letter.startsWith("A")) return "added";
  if (letter.startsWith("D")) return "deleted";
  if (letter.startsWith("R")) return "renamed";
  return "modified";
}

// Resolve git's rename path notation ("old => new", "dir/{old => new}/x") to
// the new path.
function renameTarget(p: string): string {
  if (p.includes("{")) return p.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1").replace(/\/{2,}/g, "/");
  const idx = p.indexOf(" => ");
  return idx >= 0 ? p.slice(idx + 4) : p;
}

function untrackedSummaries(cwd: string, existing: Set<string>): DiffFile[] {
  const r = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!r.ok) return [];
  const files: DiffFile[] = [];
  for (const path of r.out.split("\0").map((p) => p.trim()).filter(Boolean)) {
    if (existing.has(path)) continue;
    const ns = Bun.spawnSync({
      cmd: ["git", "-C", cwd, "diff", "--numstat", "--no-index", "--", "/dev/null", path],
      stdout: "pipe",
      stderr: "pipe",
    }).stdout.toString();
    const m = ns.split("\n").find((l) => /\t/.test(l))?.match(/^(\d+|-)\t(\d+|-)\t/);
    const binary = !!m && m[1] === "-";
    files.push({
      path,
      status: "untracked",
      additions: m && m[1] !== "-" ? Number(m[1]) : 0,
      deletions: 0,
      binary,
      hunks: [],
    });
  }
  return files;
}

// Fast overview: per-file status + line counts with NO patch bodies, so the
// viewer can render the file list instantly and lazy-load each file's hunks on
// demand (see computeSessionFileDiff).
export function computeSessionDiffSummary(cwd: string | null | undefined): SessionDiff {
  if (!isSessionWorktree(cwd)) return emptyDiff({ isWorktree: false });
  const wt = resolve(cwd!);

  const head = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return emptyDiff({ isWorktree: true, ok: false, error: "not a git checkout" });
  const branch = head.out.trim() || `session_${basename(wt)}`;

  const fetchWarning = originMainWarning(wt);
  const base = forkBase(wt);

  const counts = new Map<string, { a: number; d: number; bin: boolean }>();
  const numstat = git(wt, ["diff", "--numstat", "-M", base]);
  if (numstat.ok) {
    for (const line of numstat.out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      const path = m[3].includes("=>") ? renameTarget(m[3]) : m[3];
      counts.set(path, { a: m[1] === "-" ? 0 : Number(m[1]), d: m[2] === "-" ? 0 : Number(m[2]), bin: m[1] === "-" });
    }
  }

  const files: DiffFile[] = [];
  const nameStatus = git(wt, ["diff", "--name-status", "-M", base]);
  if (nameStatus.ok) {
    for (const line of nameStatus.out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = statusFromLetter(parts[0]);
      const oldPath = status === "renamed" ? parts[1] : undefined;
      const path = status === "renamed" ? parts[2] : parts[1];
      if (!path) continue;
      const c = counts.get(path);
      files.push({ path, oldPath, status, additions: c?.a ?? 0, deletions: c?.d ?? 0, binary: c?.bin ?? false, hunks: [] });
    }
  }

  for (const f of untrackedSummaries(wt, new Set(files.map((x) => x.path)))) files.push(f);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totals = files.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );

  return {
    ok: true,
    isWorktree: true,
    merged: branchMergedIntoMain(wt),
    branch,
    base: base.slice(0, 12),
    files,
    totals,
    truncated: false,
    fetchWarning,
  };
}

// One file's raw unified patch, loaded on demand when the user expands it in
// the viewer. Fed directly to @pierre/diffs' <PatchDiff patch=...> for
// Shiki-highlighted rendering.
export function computeSessionFilePatch(
  cwd: string | null | undefined,
  path: string,
): { path: string; patch: string; binary: boolean; truncated: boolean } | null {
  if (!isSessionWorktree(cwd)) return null;
  // Reject path traversal / absolute paths — we only diff files inside the wt.
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;
  const wt = resolve(cwd!);
  const base = forkBase(wt);

  let out = git(wt, ["diff", "--no-color", "-M", base, "--", path]).out;
  if (!out.trim()) {
    // Not in the tracked diff — try as an untracked file.
    out = Bun.spawnSync({
      cmd: ["git", "-C", wt, "diff", "--no-color", "--no-index", "--", "/dev/null", path],
      stdout: "pipe",
      stderr: "pipe",
    }).stdout.toString();
  }
  if (!out.trim()) return null;
  let truncated = false;
  if (out.length > MAX_TOTAL_BYTES) {
    out = out.slice(0, MAX_TOTAL_BYTES);
    truncated = true;
  }
  const binary = /^Binary files /m.test(out) || /\nGIT binary patch\n/.test(out);
  return { path, patch: out, binary, truncated };
}

// Lightweight summary for the poll loop — files/additions/deletions only,
// skipping full patch parsing where possible.
export function computeSessionDiffStat(cwd: string | null | undefined): {
  isWorktree: boolean;
  merged: boolean;
  files: number;
  additions: number;
  deletions: number;
} {
  if (!isSessionWorktree(cwd)) {
    return { isWorktree: false, merged: false, files: 0, additions: 0, deletions: 0 };
  }
  const wt = resolve(cwd!);
  const base = forkBase(wt);
  const numstat = git(wt, ["diff", "--numstat", base]);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  if (numstat.ok) {
    for (const line of numstat.out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (!m) continue;
      files++;
      additions += m[1] === "-" ? 0 : Number(m[1]);
      deletions += m[2] === "-" ? 0 : Number(m[2]);
    }
  }
  const untracked = git(wt, ["ls-files", "--others", "--exclude-standard"]);
  if (untracked.ok) files += untracked.out.split("\n").filter((l) => l.trim()).length;
  return { isWorktree: true, merged: branchMergedIntoMain(wt), files, additions, deletions };
}
