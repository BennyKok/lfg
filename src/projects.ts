import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

/**
 * Where to look for projects.
 *
 * An empty value is not a choice, it is an unfilled placeholder. `??` only
 * falls back on null/undefined, so `LFG_REPOS_ROOT=` in a .env resolved the
 * root to the empty string — and .env is copied from .env.example, which ships
 * exactly that line. Every install with an unedited .env therefore had no repos
 * root, which surfaces as a folder picker stuck on "Opening…": the server
 * answers its own default-directory request with 400 "folder does not exist",
 * and the picker's fallback to the repos root lands on the same error.
 */
export function reposRoot(): string {
  const configured = process.env.LFG_REPOS_ROOT?.trim();
  return configured || `${homedir()}/repos`;
}

function topFolderName(absCwd: string): string {
  const absRoot = resolve(reposRoot());
  const rel = relative(absRoot, absCwd);
  if (rel && !rel.startsWith("..") && rel !== ".." && !rel.startsWith("/")) {
    return rel.split(/[\\/]/).filter(Boolean)[0] || basename(absRoot) || absCwd;
  }
  return basename(absCwd) || absCwd;
}

function worktreeMainPath(absCwd: string): string | null {
  const gitPath = join(absCwd, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    if (statSync(gitPath).isDirectory()) return absCwd;
    const text = readFileSync(gitPath, "utf8").trim();
    const rawGitDir = text.match(/^gitdir:\s*(.+)$/i)?.[1]?.trim();
    if (!rawGitDir) return null;
    const gitDir = resolve(absCwd, rawGitDir);
    const marker = "/.git/worktrees/";
    const idx = gitDir.indexOf(marker);
    if (idx === -1) return null;
    return gitDir.slice(0, idx);
  } catch {
    return null;
  }
}

const sessionWorktreeOwnerCache = new Map<string, string | null>();

function branchExists(repo: string, branch: string): boolean {
  const gitDir = join(repo, ".git");
  if (!existsSync(gitDir)) return false;
  if (existsSync(join(gitDir, "refs", "heads", branch))) return true;
  try {
    return readFileSync(join(gitDir, "packed-refs"), "utf8").includes(` refs/heads/${branch}`);
  } catch {
    return false;
  }
}

function sessionWorktreeOwner(absCwd: string): string | null {
  const wtRoot = resolve(process.env.LFG_WORKTREE_ROOT ?? `${homedir()}/lfg-worktrees`);
  const rel = relative(wtRoot, absCwd);
  if (!rel || rel.startsWith("..") || rel === ".." || rel.startsWith("/")) return null;
  const name = rel.split(/[\\/]/).filter(Boolean)[0];
  if (!name) return null;
  if (sessionWorktreeOwnerCache.has(name)) return sessionWorktreeOwnerCache.get(name) ?? null;

  const branch = `session_${name}`;
  const root = resolve(reposRoot());
  let owner: string | null = null;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const repo = join(root, entry.name);
      if (existsSync(join(repo, ".git", "worktrees", name)) || branchExists(repo, branch)) {
        owner = repo;
        break;
      }
    }
  } catch {}
  sessionWorktreeOwnerCache.set(name, owner);
  return owner;
}

function isSessionWorktreePath(absCwd: string): boolean {
  const wtRoot = resolve(process.env.LFG_WORKTREE_ROOT ?? `${homedir()}/lfg-worktrees`);
  const rel = relative(wtRoot, absCwd);
  return !!rel && !rel.startsWith("..") && rel !== ".." && !rel.startsWith("/");
}

// Project identity is the top-level repository project, not the full cwd.
// Nested directories and git worktrees collapse back to their main project so
// temporary branch/worktree folders do not become separate project filters.
export function projectName(cwd: string | null, opts?: { repoRoot?: string | null }): string {
  const projectCwd = opts?.repoRoot || cwd;
  if (!projectCwd) return "-";
  const absCwd = resolve(projectCwd);
  const main = worktreeMainPath(absCwd) ?? sessionWorktreeOwner(absCwd);
  if (!main && isSessionWorktreePath(absCwd)) return "worktree";
  return topFolderName(main ?? absCwd);
}
