// The editable surface, via @pierre/diffs' Editor (piece table, undo stack,
// bracket matching, find-in-file). Its own chunk — roughly 74 KB gzipped — so
// only people who actually press Edit pay for it.
//
// Nothing here writes to disk. The edited text is lifted to the panel, which
// turns it into a patch and sends it to the agent as a chat message, keeping the
// agent the single writer of its own worktree.

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { EditProvider, File } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/edit";
import { PIERRE_THEME, type SessionFile, type ThemeType } from "./types";

function FileEditorInner({
  file,
  themeType,
  onChange,
}: {
  file: SessionFile;
  themeType: ThemeType;
  onChange: (contents: string) => void;
}) {
  // Keep the latest callback in a ref: the editor factory must stay stable
  // across renders or every keystroke would tear down and rebuild the editor.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const createEditor = useCallback(
    (options: ConstructorParameters<typeof Editor>[0]) =>
      new Editor({
        ...options,
        onChange: (next) => onChangeRef.current(next.contents),
      }),
    [],
  );

  const options = useMemo(
    () => ({ theme: PIERRE_THEME, themeType, overflow: "wrap" as const, disableFileHeader: true }),
    [themeType],
  );

  return (
    <EditProvider createEditor={createEditor}>
      <File
        // A stable cacheKey per path lets the editor keep undo history and
        // cursor position when the user toggles between view and edit.
        file={{ name: file.name, contents: file.contents, cacheKey: file.path }}
        options={options}
        edit
        disableWorkerPool
      />
    </EditProvider>
  );
}

export default memo(FileEditorInner);
