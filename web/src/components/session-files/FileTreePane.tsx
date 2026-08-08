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
import { pinShadowTextSizeForTouch } from "@/lib/shadow-text-size";
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

  const hostRef = useRef<HTMLDivElement | null>(null);

  // The tree's search box lives in a shadow root at 13px, where the app's global
  // "16px on coarse pointers" rule cannot reach it — so tapping it zoomed iOS
  // Safari into the sheet and left no way back out.
  useEffect(() => pinShadowTextSizeForTouch(hostRef.current), []);

  // Re-tapping the row that is already selected.
  //
  // On a phone the file opens as its own screen and Back returns here with the
  // row still selected, so tapping it again is the obvious way to get the file
  // back — but selecting an already-selected path is a no-op inside the tree
  // (it does not bump the controller's selection version, so nothing is
  // emitted) and the tap would do nothing at all. The click that produced it
  // still crosses the shadow boundary on its way out, so re-report from there.
  // By the time this listener runs the tree has already applied any selection
  // change of its own, so a tap on a *different* row falls through to the
  // effect above instead of double-reporting.
  const onSelectFileRef = useRef(onSelectFile);
  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (event: MouseEvent) => {
      // Typing in the tree's own search box must not reopen anything.
      if (event.composedPath().some((node) => node instanceof HTMLInputElement)) return;
      const path = model.getSelectedPaths()[0];
      if (!path || path !== lastReported.current) return;
      if (model.getItem(path)?.isDirectory()) return;
      onSelectFileRef.current(path);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, [model]);

  return (
    <div ref={hostRef} className="h-full w-full">
      <FileTree model={model} className="h-full w-full" style={{ height: "100%" }} />
    </div>
  );
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
