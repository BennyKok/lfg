import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The picker opens on the last-used project path, which is remembered in
// localStorage ("lfg_v2_repo") and never revalidated. Once that folder is
// deleted or renamed (a pruned worktree, say), /api/filesystem/directories
// answers 400 "folder does not exist" — and before the fallback below that
// left the drawer stranded: header stuck on "Opening…", no listing, and both
// "New Folder" and "Use This Folder" disabled, because they gate on `browser`
// being non-null. Close was the only way out, and reopening hit the same path.
async function projectFolderBrowser() {
  const app = await readFile("web/src/App.tsx", "utf8");
  const start = app.indexOf("function ProjectFolderBrowser(");
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf("\nfunction ", start + 1);
  return app.slice(start, end === -1 ? undefined : end);
}

describe("project folder browser: unavailable starting folder", () => {
  test("falls back to the default root when the remembered folder is gone", async () => {
    const component = await projectFolderBrowser();

    // The initial open opts into the fallback...
    expect(component).toMatch(/void browse\(initialPath,\s*true\)/);
    // ...and the failure path re-requests the endpoint with no path, which the
    // server answers with the repos root.
    const cat = component.indexOf("} catch (e) {");
    const handler = component.slice(cat, component.indexOf("} finally {", cat));
    expect(handler).toMatch(/api<FolderBrowserPayload>\("\/api\/filesystem\/directories"\)/);
    expect(handler).toContain("setBrowser(");
  });

  test("keeps the fallback opt-in so manual navigation still reports failure", async () => {
    const component = await projectFolderBrowser();

    // Clicking into a folder must not silently teleport the user to the root —
    // only the initial open passes the flag.
    expect(component).toMatch(/const browse = useCallback\(\s*async \(path\?: string, fallbackToRoot = false\)/);
    expect(component).toMatch(/onClick=\{\(\) => void browse\(browser\.parent!\)\}/);
    expect(component).toMatch(/onClick=\{\(\) => void browse\(directory\.path\)\}/);
  });
});
