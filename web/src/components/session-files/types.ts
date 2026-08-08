// Shared wire types for the Files panel. Kept in their own module so the panel
// shell can reference them without pulling in either Pierre chunk.

export type TreeGitStatus = "added" | "deleted" | "ignored" | "modified" | "renamed" | "untracked";

export type TreeGitStatusEntry = { path: string; status: TreeGitStatus };

export type SessionTree = {
  ok: boolean;
  root: string;
  ceiling: string;
  parent: string | null;
  paths: string[];
  gitStatus: TreeGitStatusEntry[];
  truncated: boolean;
  error?: string;
};

export type SessionFile = {
  path: string;
  name: string;
  contents: string;
  size: number;
  binary: boolean;
  truncated: boolean;
};

export type ThemeType = "light" | "dark";

export const PIERRE_THEME = { dark: "github-dark", light: "github-light" } as const;
