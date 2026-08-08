import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The Files panel shipped as one responsive stack: a 208px-tall tree strip with
// the file view crammed into whatever was left. On a phone that meant ~5 lines
// of the file, a header pushed down by a wrapping breadcrumb, and a Send button
// under the home indicator. These assertions pin the two-shape layout that
// replaced it, because every one of them is invisible on a desktop viewport and
// would rot silently otherwise.

const panel = readFileSync("web/src/components/session-files/SessionFilesPanel.tsx", "utf8");
const tree = readFileSync("web/src/components/session-files/FileTreePane.tsx", "utf8");
const editor = readFileSync("web/src/components/session-files/FileEditor.tsx", "utf8");
const bar = readFileSync("web/src/components/SessionDiffView.tsx", "utf8");

describe("Files panel: phone layout", () => {
  test("the tree fills the sheet instead of a fixed-height strip", () => {
    expect(panel).not.toContain("h-52");
    // Tree pane: flexes to fill below md, fixed column from md up.
    expect(panel).toMatch(/<aside className="[^"]*flex-1[^"]*md:w-72[^"]*md:flex-none/);
  });

  test("a file opens as its own screen over the sheet, and back returns", () => {
    expect(panel).toContain('const fileScreenUp = !!selected && phoneScreen === "file"');
    expect(panel).toMatch(/fileScreenUp \? "absolute inset-0 z-20 flex" : "hidden"/);
    expect(panel).toContain('aria-label="Back to file tree"');
    // md keeps both panes: the overlay classes must be undone at the breakpoint.
    expect(panel).toMatch(/md:static md:flex md:flex-1/);
  });

  test("back keeps the selection so the file screen can be restored", () => {
    // Clearing `selected` would strand the file: the tree does not re-report a
    // selection that did not change, so the row could never reopen it.
    expect(panel).toMatch(/backToTree = useCallback\(\(\) => setPhoneScreen\("tree"\)/);
    expect(panel).not.toMatch(/backToTree[\s\S]{0,200}setSelected\(null\)/);
  });

  test("re-tapping the already-open row reopens it", () => {
    expect(tree).toContain("composedPath()");
    expect(tree).toContain('host.addEventListener("click", onClick)');
    // Typing in the tree's search box must not be mistaken for a row tap.
    expect(tree).toContain("HTMLInputElement");
  });
});

describe("Files panel: viewport and safe areas", () => {
  test("the sheet rides the visual viewport, not dvh", () => {
    // iOS keeps the layout viewport full height under the soft keyboard, so a
    // dvh-sized sheet ends up half under it.
    expect(panel).toContain('top: "var(--lfg-visual-offset-top, 0px)"');
    expect(panel).toContain('height: "var(--lfg-visual-height, var(--lfg-app-height, 100dvh))"');
    expect(panel).not.toContain("fixed inset-0 z-[110]");
  });

  test("both full-bleed headers clear the status bar", () => {
    const insets = panel.match(/pt-\[calc\(0\.5rem\+env\(safe-area-inset-top,0px\)\)\]/g);
    expect(insets?.length).toBeGreaterThanOrEqual(2);
  });

  test("whatever ends the sheet clears the home indicator", () => {
    expect(panel).toContain('const lastBlock = banner ? "banner" : editing ? "editor" : "content"');
    expect(panel).toContain("pb-[var(--lfg-safe-bottom,0px)]");
    expect(panel).toContain("pb-[max(var(--lfg-safe-bottom,0px),0.75rem)]");
  });

  test("the page behind the sheet is locked while it is open", () => {
    expect(panel).toContain('document.body.style.overflow = "hidden"');
    expect(panel).toContain("overscroll-contain");
  });
});

describe("Files panel: touch targets", () => {
  test("the breadcrumb scrolls sideways rather than wrapping the header", () => {
    expect(panel).toContain("overflow-x-auto whitespace-nowrap");
    expect(panel).not.toContain("flex-wrap items-center gap-0.5 font-mono");
    // Scrolled to the end, so the segments nearest the current directory show.
    expect(panel).toContain("rail.scrollLeft = rail.scrollWidth");
  });

  test("header and toolbar controls are thumb-sized below md", () => {
    // size-9 / min-h-9 on phones, collapsed back to the compact desktop sizing.
    expect(panel).toMatch(/size-9 shrink-0 items-center justify-center[^"]*md:(size-auto md:p-1\.5|hidden)/);
    expect(panel).toMatch(/min-h-9 shrink-0 items-center[^"]*md:min-h-0/);
  });

  test("send-to-agent stacks and goes full width on a phone", () => {
    expect(panel).toContain("flex flex-col gap-2 md:flex-row md:items-center");
    expect(panel).toMatch(/min-h-11 w-full[^"]*md:min-h-0 md:w-auto/);
  });

  test("the pill row wraps instead of clipping on a narrow screen", () => {
    expect(bar).toContain("flex flex-wrap justify-center gap-2 px-3");
  });
});

describe("Files panel: iOS focus zoom", () => {
  test("both shadow-root surfaces pin their text fields to 16px", () => {
    // index.css already does this for the document; CSS does not cross a shadow
    // boundary, and both Pierre surfaces render their real field inside one.
    expect(tree).toContain("pinShadowTextSizeForTouch(hostRef.current)");
    expect(editor).toContain("pinShadowTextSizeForTouch(hostRef.current)");
  });
});
