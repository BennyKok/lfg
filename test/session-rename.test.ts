import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const app = readFileSync("web/src/App.tsx", "utf8");

describe("session rename UX", () => {
  test("uses in-place editors on mobile instead of a rename drawer", () => {
    expect(app).not.toContain("RenameSessionDrawer");
    expect(app.match(/<SessionTitleInlineEditor/g)?.length).toBe(2);
    expect(app).toContain("setRenamingInline(true)");
  });

  test("updates optimistically and fences stale session updates", () => {
    const renameStart = app.indexOf(
      "const renameSession = useCallback<RenameSession>",
    );
    const optimisticUpdate = app.indexOf("setSessions((current) =>", renameStart);
    const networkWrite = app.indexOf("await putSessionTitle(sid, title)", renameStart);

    expect(renameStart).toBeGreaterThan(-1);
    expect(optimisticUpdate).toBeGreaterThan(renameStart);
    expect(networkWrite).toBeGreaterThan(optimisticUpdate);
    expect(app).toContain("persistedAfterFetch");
    expect(app).toContain("sessionsAppliedFetchRevisionRef");
    expect(app).toContain("sessionTitleQueuesRef");
    expect(app).toContain("const liveTitleConfirmed");
    expect(app).toContain("pendingRename?.title");
  });
});
