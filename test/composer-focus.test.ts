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

  test("covers the new-session composer with immediate creation feedback", async () => {
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
  });
});
