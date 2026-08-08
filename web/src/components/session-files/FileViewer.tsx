// Read-only file rendering, via @pierre/diffs' <File> (Shiki-highlighted, same
// renderer the diff viewer already uses). Its own chunk so opening the Files
// panel does not pay for the code renderer until a file is actually opened.

import { memo } from "react";
import { File } from "@pierre/diffs/react";
import { PIERRE_THEME, type SessionFile, type ThemeType } from "./types";

function FileViewerInner({ file, themeType }: { file: SessionFile; themeType: ThemeType }) {
  return (
    <File
      file={{ name: file.name, contents: file.contents }}
      options={{ theme: PIERRE_THEME, themeType, overflow: "wrap", disableFileHeader: true }}
      disableWorkerPool
    />
  );
}

export default memo(FileViewerInner);
