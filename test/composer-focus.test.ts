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
});
