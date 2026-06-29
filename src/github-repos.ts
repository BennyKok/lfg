// GitHub repo discovery and auto-clone for the lfg repo picker.
// Requires GITHUB_TOKEN env var (a personal access token with `repo` scope,
// or a fine-grained token with read access to your repos).

import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { reposRoot } from "./projects.ts";
import { addCustomRepo } from "./repos-store.ts";

export type GithubRepo = {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  ssh_url: string;
  description: string | null;
  private: boolean;
  updated_at: string;
  language: string | null;
};

function token(): string | null {
  return process.env.GITHUB_TOKEN ?? null;
}

export function githubConfigured(): boolean {
  return !!token();
}

// Fetch all repos for the authenticated user (up to 100 most recently updated).
export async function fetchGithubRepos(): Promise<GithubRepo[]> {
  const tok = token();
  if (!tok) throw new Error("GITHUB_TOKEN is not set");

  const repos: GithubRepo[] = [];
  let page = 1;

  while (repos.length < 200) {
    const res = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&direction=desc`,
      {
        headers: {
          Authorization: `Bearer ${tok}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API error ${res.status}: ${body.slice(0, 200)}`);
    }
    const page_repos = (await res.json()) as GithubRepo[];
    if (!page_repos.length) break;
    repos.push(...page_repos);
    if (page_repos.length < 100) break;
    page++;
  }

  return repos;
}

// Clone a GitHub repo into LFG_REPOS_ROOT/<name> (if not already there),
// then register it as a custom repo so it appears in the picker immediately.
// Returns the local path.
export async function cloneGithubRepo(
  cloneUrl: string,
  repoName: string,
): Promise<string> {
  const tok = token();
  const root = reposRoot();
  mkdirSync(root, { recursive: true });

  const dest = join(root, basename(repoName));

  if (existsSync(join(dest, ".git"))) {
    // Already cloned — just pull latest.
    const pull = Bun.spawnSync(["git", "-C", dest, "pull", "--ff-only"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pull.exitCode !== 0) {
      // Non-fatal: repo exists, just couldn't fast-forward. Return existing path.
    }
    await addCustomRepo(dest, repoName);
    return dest;
  }

  // Inject token into HTTPS URL for private repos.
  let url = cloneUrl;
  if (tok && url.startsWith("https://")) {
    url = url.replace("https://", `https://oauth2:${tok}@`);
  }

  const clone = Bun.spawnSync(["git", "clone", "--depth", "1", url, dest], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (clone.exitCode !== 0) {
    const err = new TextDecoder().decode(clone.stderr);
    throw new Error(`git clone failed: ${err.slice(0, 400)}`);
  }

  await addCustomRepo(dest, repoName);
  return dest;
}
