import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("composer focus after send", () => {
  test("dismisses the live-session message input after a valid send", async () => {
    const app = await readFile("web/src/App.tsx", "utf8");
    expect(app).toContain("const messageInputRef = useRef<HTMLTextAreaElement>(null)");
    expect(app).toContain("messageInputRef.current?.blur()");
    expect(app).toContain("textareaRef={messageInputRef}");
  });

  test("dismisses the inline new-session composer instead of refocusing it", async () => {
    const app = await readFile("web/src/App.tsx", "utf8");
    expect(app).toContain('fieldRef.current?.querySelector("textarea")?.blur()');
    expect(app).not.toContain(
      'requestAnimationFrame(() => fieldRef.current?.querySelector("textarea")?.focus())',
    );
  });

  test("covers the new-session input card with immediate creation feedback", async () => {
    const app = await readFile("web/src/App.tsx", "utf8");
    const dialogStart = app.indexOf("function NewSessionDialog");
    const submitStart = app.indexOf(
      "function submit(e?: FormEvent, overrideText?: string)",
      dialogStart,
    );
    const submit = app.slice(
      submitStart,
      app.indexOf("// Inline composer resting state", submitStart),
    );

    expect(submit).toContain("if (launching) return");
    expect(submit).not.toContain("onClose();");
    expect(app).toContain("aria-busy={launching}");
    expect(app).toContain("<ShimmerText className=\"text-sm font-medium\">Creating session…</ShimmerText>");

    const formStart = app.indexOf("const formBody", dialogStart);
    const fileInput = app.indexOf("{files.fileInput}", formStart);
    const fieldStart = app.indexOf('"lfg-gfield relative rounded-2xl"', fileInput);
    const statusStart = app.indexOf('role="status"', fieldStart);
    const textareaStart = app.indexOf("<ComposerTextarea", fieldStart);

    expect(app.slice(formStart, fileInput)).not.toContain('role="status"');
    expect(statusStart).toBeGreaterThan(fieldStart);
    expect(statusStart).toBeLessThan(textareaStart);
    expect(app.slice(statusStart, textareaStart)).toContain("rounded-2xl");
  });
});
