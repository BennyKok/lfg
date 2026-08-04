import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * The composer's image path: attachments are downscaled before they upload, and
 * full resolution is an explicit per-image opt-in.
 *
 * `useComposerAttachments` lives inside the App.tsx monolith, so these are
 * source assertions on the wiring that makes the guarantee hold (same approach
 * as the other composer tests here).
 */
async function app(): Promise<string> {
  return readFile("web/src/App.tsx", "utf8");
}

function hookSource(source: string): string {
  const start = source.indexOf("function useComposerAttachments");
  expect(start).toBeGreaterThan(0);
  return source.slice(start, source.indexOf("\n// Fire-and-forget instrumentation", start));
}

describe("composer image compression", () => {
  test("image attachments are downscaled before their upload starts", async () => {
    const hook = hookSource(await app());

    // Every attach goes through the single entry point, which routes images
    // into the downscaler and everything else straight to the uploader.
    expect(hook).toContain("for (const att of next) startAttachmentUpload(att);");
    expect(hook).toContain("if (!isCompressibleImage(att.file)) {\n        prefetchUpload(att);");
    expect(hook).toContain("void prepareAttachment({ ...att, preparing: true });");
    expect(hook).toContain("compressImageFile(att.file)");
  });

  test("an annotated screenshot is compressed on the same terms", async () => {
    const hook = hookSource(await app());
    const annotator = hook.slice(
      hook.indexOf("const annotator = ("),
      hook.indexOf("const chips = ("),
    );

    // The annotator hands its drawn-on copy back through the same entry point
    // rather than uploading it raw.
    expect(annotator).toContain("startAttachmentUpload,");
    expect(annotator).not.toContain("prefetchUpload");
    // And the raw uploader is not reachable from outside the hook at all.
    const exports = hook.slice(hook.lastIndexOf("  return {"));
    expect(exports).not.toContain("prefetchUpload");
    expect(exports).toContain("startAttachmentUpload,");
  });

  test("a send mid-compress waits for the small copy", async () => {
    const hook = hookSource(await app());
    const resolve = hook.slice(hook.indexOf("const resolveUpload = useCallback"));

    expect(resolve).toContain("const pending = preparedRef.current.get(att.id)");
    expect(resolve).toContain("await pending");
    // Prefer live composer state (a later HD toggle or annotation), falling
    // back to the prepared result while the ref is still catching up.
    expect(resolve).toContain(
      "const target = current && !current.preparing ? current : (prepared ?? current ?? att);",
    );
  });

  test("HD re-uploads the original and stays reversible", async () => {
    const hook = hookSource(await app());
    const toggle = hook.slice(
      hook.indexOf("const setAttachmentHd = useCallback"),
      hook.indexOf("const removeAttachment = useCallback"),
    );

    expect(toggle).toContain("const file = hd ? current.original : current.compressed;");
    // Re-uploading through prefetchUpload mints a fresh token, so the
    // superseded attempt can't write its path back into the attachment.
    expect(toggle).toContain("prefetchUpload({ ...current, ...patch })");
    expect(toggle).toContain('status: "ready"');
  });

  test("annotating drops both copies so HD can't restore the undrawn image", async () => {
    const source = await app();
    const annotate = source.slice(
      source.indexOf("function applyAnnotatedAttachment"),
      source.indexOf("// Attachments upload as soon as they are attached"),
    );

    expect(annotate).toContain("delete next.original;");
    expect(annotate).toContain("delete next.compressed;");
    expect(annotate).toContain("delete next.hd;");
  });

  test("every composer offers the HD toggle", async () => {
    const source = await app();
    // The hook's own chips (fork dialog), the chat composer and the
    // new-session composer, which each render the chip row themselves.
    expect(source.match(/onToggleHd=\{(files\.)?setAttachmentHd\}/g)).toHaveLength(3);
  });

  test("the HD control stays visible for every image", async () => {
    const source = await app();
    const chips = source.slice(
      source.indexOf("function ComposerAttachmentChips"),
      source.indexOf("// Everything a composer needs to accept files"),
    );

    expect(chips).toContain("att.previewUrl && onToggleHd");
    expect(chips).toContain("is already full resolution");
    expect(chips).toContain(
      "disabled={disabled || locked || !(att.original && att.compressed)}",
    );
    expect(chips).toContain('att.preparing\n                ? "Compressing…"');
  });
});
