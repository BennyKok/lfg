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

  test("shares the immersive hold-and-slide control across launch surfaces", async () => {
    const source = await app();
    const start = source.indexOf("function ThinkingSignal(");
    const end = source.indexOf("function ModelPicker(", start);
    const control = source.slice(start, end);
    const forkStart = source.indexOf("function ForkSessionDialog(");
    const forkEnd = source.indexOf("function useOrganicActivityPresence(", forkStart);
    const forkDialog = source.slice(forkStart, forkEnd);
    const autoPickerStart = source.indexOf("function AutoAgentModelPicker(");
    const autoPickerEnd = source.indexOf("function BottomSheet(", autoPickerStart);
    const autoPicker = source.slice(autoPickerStart, autoPickerEnd);

    // New-session composer, fork dialog, and finding/auto-agent picker.
    expect(source.match(/\simmersive\s*\/>/g)?.length).toBe(3);
    expect(forkDialog).toContain("immersive");
    expect(autoPicker).toContain("immersive");
    expect(control).toContain("THINKING_HOLD_MS");
    expect(control).toContain("thinkingScrubStepWidth");
    expect(control).toContain("applyScrubDelta");
    expect(control).toContain("onPointerMove={handlePointerMove}");
    expect(control).toContain("startIndexRef.current + relativeStepOffsetRef.current");
    // Moving before hold completes cancels scrub (keeps tap-to-menu clean).
    expect(control).toContain("if (Math.abs(delta) > 10) clearHoldTimer()");
    expect(source).toContain("Math.max(34, Math.min(52, 240 / Math.max(1, levelCount - 1)))");
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

  test("hold-to-scrub panel uses a thick track and rounded-square thumb with morphing accent", async () => {
    const source = await app();
    const start = source.indexOf("function ComposerThinkingControl(");
    const end = source.indexOf("function ModelPicker(", start);
    const control = source.slice(start, end);
    const css = await readFile("web/src/index.css", "utf8");

    expect(control).toContain('className="thinking-scrubber"');
    expect(control).toContain("thinking-scrubber-track");
    expect(control).toContain("thinking-scrubber-matrix");
    expect(control).toContain("thinking-scrubber-fill");
    expect(control).toContain("thinking-scrubber-thumb");
    expect(control).toContain("thinking-scrubber-halo");
    expect(control).toContain("thinkingAccentColor(previewProgress)");
    expect(control).toContain('"--thinking-progress": previewProgress');
    expect(control).toContain('"--thinking-accent": previewAccent');
    // Card chrome back so the floating control stays readable over transcript.
    expect(control).toContain("bg-popover/95");
    expect(control).toContain("ring-1 ring-foreground/10");
    expect(control).toContain("shadow-2xl");
    // Dot markers replaced by the pixel-matrix track + chunky squircle thumb.
    expect(control).not.toContain("rounded-full bg-popover ring-2");
    expect(control).not.toContain("from-sky-400/35 via-violet-400/55");
    expect(source).toContain("THINKING_ACCENT_STOPS");
    expect(source).toContain("function thinkingAccentColor(");

    expect(css).toContain(".thinking-scrubber-track");
    expect(css).toContain(".thinking-scrubber-matrix");
    expect(css).toContain(".thinking-scrubber-thumb");
    expect(css).toContain("--thinking-matrix-mask");
    expect(css).toContain("border-radius: 0.52rem");
    expect(css).toContain("height: 1.45rem");
    expect(css).toContain("rgba(0, 122, 255");
    expect(css).toContain("rgba(175, 82, 222");
    expect(css).toContain("rgba(232, 121, 249");
  });
});
