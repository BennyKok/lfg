// The tree half of the Files panel, built on @pierre/trees (trees.software).
//
// Loaded as its own chunk: @pierre/trees renders into a shadow root and brings
// its own preact runtime, so it must stay out of the first-paint bundle. The
// panel shell lazy-imports this module only once the user opens Files.
//
// @pierre/trees takes a FLAT path list and virtualizes rendering — there is no
// per-directory loader — so a root switch is `resetPaths`, not an expansion.

import { memo, useEffect, useRef } from "react";
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import type { TreeGitStatusEntry } from "./types";

export type FileTreePaneProps = {
  paths: string[];
  gitStatus: TreeGitStatusEntry[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
};

function FileTreePaneInner({ paths, gitStatus, selectedPath, onSelectFile }: FileTreePaneProps) {
  // The model is created once and re-fed on every root change. Recreating it per
  // root would drop the shadow root and remount the whole tree on each
  // breadcrumb click.
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    paths: [],
    search: true,
    fileTreeSearchMode: "hide-non-matches",
  });

  // The tree re-publishes its selection on every store notification — focus
  // moves, expand/collapse, a git-status refresh — each time as a fresh array.
  // Forwarding all of those would re-open the already-open file, which resets
  // the editor document and silently discards an in-progress edit. Only a
  // genuine change of path is worth reporting.
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    // Server output is already sorted, so the tree can skip its own sort pass.
    model.resetPaths(paths, { initialExpandedPaths: expandedForSelection(selectedPath) });
    model.setGitStatus(gitStatus);
    // A new root is a new path namespace: the same relative path can legitimately
    // be selected again, so forget what was last reported.
    lastReported.current = null;
    // `selectedPath` is deliberately not a dependency: it seeds the initial
    // expansion for a newly loaded root, but re-running on every selection
    // would collapse folders the user just opened by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, paths, gitStatus]);

  const selection = useFileTreeSelection(model);

  useEffect(() => {
    const path = selection[0];
    if (!path || path === lastReported.current) return;
    // Directory rows toggle expansion themselves; only files open in the viewer.
    if (model.getItem(path)?.isDirectory()) return;
    lastReported.current = path;
    onSelectFile(path);
  }, [model, selection, onSelectFile]);

  return <FileTree model={model} className="h-full w-full" style={{ height: "100%" }} />;
}

// Expand the ancestors of the file being restored so it is visible on open.
function expandedForSelection(path: string | null): string[] {
  if (!path) return [];
  const segments = path.split("/");
  segments.pop();
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) out.push(segments.slice(0, i + 1).join("/"));
  return out;
}

export default memo(FileTreePaneInner);
