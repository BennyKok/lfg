import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const app = () => readFile("web/src/App.tsx", "utf8");

describe("thinking level menu", () => {
  test("uses a stable Thinking label while retaining the level choices", async () => {
    const source = await app();
    const start = source.indexOf("function ThinkingLevelPill(");
    const end = source.indexOf("function ModelPicker(", start);
    const pill = source.slice(start, end);

    expect(pill).toContain('>Thinking</span>');
    expect(pill).toContain('aria-label="Thinking"');
    expect(pill).toContain("title={`Thinking: ${value}`}");
    expect(pill).toContain("{levels.map((item) => (");
    expect(pill).not.toContain('aria-label="Thinking level"');
  });

  test("all composer surfaces use the shared labeled menu", async () => {
    const source = await app();
    expect(source.match(/<ThinkingLevelPill/g)?.length).toBe(3);
    expect(source).not.toContain('aria-label="Thinking level"');
  });

  test("uses Thinking for the live-session menu label", async () => {
    const source = await app();
    const start = source.indexOf("function SessionThinkingLevelSubmenu(");
    const end = source.indexOf("function SessionTitleSheet(", start);
    const submenu = source.slice(start, end);

    expect(submenu).toContain('<span className="flex-1">Thinking</span>');
    expect(submenu).toContain("<DropdownMenuLabel>Thinking level</DropdownMenuLabel>");
  });

  test("shares the immersive hold-and-slide control with fork and continue", async () => {
    const source = await app();
    const start = source.indexOf("function ThinkingSignal(");
    const end = source.indexOf("function ModelPicker(", start);
    const control = source.slice(start, end);
    const forkStart = source.indexOf("function ForkSessionDialog(");
    const forkEnd = source.indexOf("function useOrganicActivityPresence(", forkStart);
    const forkDialog = source.slice(forkStart, forkEnd);

    expect(source.match(/\simmersive\s*\/>/g)?.length).toBe(2);
    expect(forkDialog).toContain("immersive");
    expect(control).toContain("THINKING_HOLD_MS");
    expect(control).toContain("onPointerMove={handlePointerMove}");
    expect(control).toContain("event.clientX - lastPointerXRef.current");
    expect(control).toContain("startIndexRef.current + relativeStepOffsetRef.current");
    expect(control).toContain("Tap to choose · hold and slide to adjust");
    expect(control).toContain("Hold the control and slide for a faster adjustment.");
    expect(control).toContain("createPortal(");
    expect(control).toContain("<ThinkingSignal value={value} levels={levels} />");
    expect(control).toContain("{value}");
    expect(control).toContain("capitalize text-muted-foreground");
    expect(control).toContain('WebkitTouchCallout: "none"');
    expect(control).toContain("document.getSelection()?.removeAllRanges()");
    expect(control).not.toContain("<BrainCircuit");
  });
});
