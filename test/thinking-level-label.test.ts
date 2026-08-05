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
    // Immersive path is slider-only; non-immersive still has a native select.
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
    expect(control).toContain("applyScrub");
    // Both triggers spread the one gesture engine's pointer props.
    expect(control.match(/\{\.\.\.scrub\.pointerProps\}/g)?.length).toBe(2);
    expect(control).toContain(
      "Math.round(startIndexRef.current + travel / thinkingScrubStepWidth(levels.length))",
    );
    // Axis lock: sideways OR upward travel drives the scrub, so a trigger
    // pinned to the bottom-right corner is still reachable.
    expect(control).toContain("THINKING_AXIS_LOCK_PX");
    expect(control).toContain('axisRef.current = Math.abs(dx) >= Math.abs(dy) ? "x" : "y"');
    expect(control).toContain('const travel = axisRef.current === "x" ? dx : -dy');
    // Slider-only: no dropdown menu after scrub / on tap.
    expect(control).not.toContain("<DropdownMenu");
    expect(control).not.toContain("DropdownMenuContent");
    expect(control).not.toContain("ChevronDown");
    expect(control).not.toContain("chooseLevel");
    expect(control).not.toContain("menuOpen");
    // Horizontal intent opens the scrubber immediately.
    expect(control).toContain("beginScrub(event.currentTarget)");
    expect(source).toContain("Math.max(34, Math.min(52, 240 / Math.max(1, levelCount - 1)))");
    // Haptics: arm on pointer down, engage on hold, tick each level, success on release.
    expect(control).toContain('haptic("light")');
    expect(control).toContain('haptic("heavy")');
    expect(control).toContain('haptic("medium")');
    expect(control).toContain("feedback.success()");
    expect(control).toContain("Hold and slide to adjust");
    expect(control).toContain("createPortal(");
    // The pill mirrors the level under the finger, so trigger and panel agree.
    expect(control).toContain("const shown = scrub.scrubbing ? scrub.previewLevel : value");
    expect(control).toContain("<ThinkingSignal value={shown} levels={levels} />");
    expect(control).toContain("{shown}");
    expect(control).toContain('WebkitTouchCallout: "none"');
    expect(control).toContain("document.getSelection()?.removeAllRanges()");
    expect(control).not.toContain("<BrainCircuit");

    // Reachable without a pointer: the pill is a real slider with arrow keys.
    expect(control).toContain('role="slider"');
    expect(control).toContain("aria-valuenow={currentIndex}");
    expect(control).toContain("aria-valuetext={value}");
    expect(control).toContain("scrub.nudge(step)");
    // Escape aborts an open scrub without committing.
    expect(control).toContain('if (event.key !== "Escape") return');
    expect(control).toContain("finishScrub(false)");
  });

  test("the scrub drag is consumed rather than smearing a text selection", async () => {
    const source = await app();
    const hookStart = source.indexOf("function useThinkingScrub(");
    const hookEnd = source.indexOf("function ComposerThinkingControl(", hookStart);
    const hook = source.slice(hookStart, hookEnd);
    const triggers = source.slice(hookEnd, source.indexOf("function ModelPicker(", hookEnd));
    const css = await readFile("web/src/index.css", "utf8");

    // `user-select: none` on the trigger is not enough — the browser anchors a
    // selection on press and extends it over whatever the drag passes over.
    expect(source).toContain("function preventThinkingDragDefault(");
    expect(hook).toContain(
      'document.addEventListener("selectstart", preventThinkingDragDefault, true)',
    );
    expect(hook).toContain(
      'document.addEventListener("dragstart", preventThinkingDragDefault, true)',
    );
    // Armed on press, so the drag that *opens* the scrubber is swallowed too.
    expect(hook).toContain("guardSelection();");
    // Released on pointer up, pointer cancel, and unmount — no leaked listener
    // that would silently break selection everywhere else in the app.
    expect(hook.match(/releaseSelectionGuard\(\);/g)?.length).toBe(3);

    // While the panel is up the whole page belongs to the gesture.
    expect(hook).toContain('document.body.classList.add("thinking-scrubbing")');
    expect(hook).toContain('document.body.classList.remove("thinking-scrubbing")');
    expect(css).toContain("body.thinking-scrubbing");
    expect(css).toContain("user-select: none !important");
    expect(css).toContain("cursor: grabbing");

    // Both triggers opt out of selection themselves. Start used to be missing
    // this while the pill had it.
    expect(triggers.match(/(?<![A-Za-z])userSelect: "none"/g)?.length).toBe(2);
    expect(triggers.match(/WebkitUserSelect: "none"/g)?.length).toBe(2);
    // And neither may be dragged or long-press-called-out.
    expect(triggers.match(/WebkitTouchCallout: "none"/g)?.length).toBe(2);
    expect(triggers.match(/touchAction: "none"/g)?.length).toBe(2);
  });

  test("holding Start opens the scrubber and releasing sets the level and launches", async () => {
    const source = await app();
    const start = source.indexOf("function ComposerStartButton(");
    const end = source.indexOf("function ModelPicker(", start);
    const button = source.slice(start, end);

    // Start still submits the form on a plain tap.
    expect(button).toContain('type="submit"');
    // Hold raises the same scrubber the pill uses, captioned for launching.
    expect(button).toContain("useThinkingScrub(");
    expect(button).toContain('caption: "Start thinking"');
    expect(button).toContain("{...scrub.pointerProps}");
    expect(button).toContain("{scrub.panel}");
    // Release commits the scrubbed level AND launches, in one gesture.
    expect(button).toContain("onCommit: (next) => onLaunch(next)");
    // ...and the browser's trailing click must not submit a second time.
    expect(button).toContain("if (scrub.consumeSuppressedClick())");
    expect(button).toContain("event.preventDefault()");
    // Live level shown on the button itself while scrubbing.
    expect(button).toContain("scrub.scrubbing ? scrub.previewLevel : \"Start\"");
    // Agents with no reasoning knob get a plain button (levels list is empty).
    expect(button).toContain("const holdable = !disabled && thinkingLevels.length > 1");

    // The composer wires the gesture's level straight into the launch payload
    // rather than reading state that has not re-rendered yet.
    expect(source).toContain(
      "function submit(e?: FormEvent, overrideText?: string, overrideThinking?: ThinkingLevel)",
    );
    expect(source).toContain("const launchThinkingLevel = overrideThinking ?? thinkingLevel");
    expect(source).toContain("thinkingLevels={agentSupportsThinking(agent) ? thinkingLevels : []}");
    expect(source).toContain("submit(undefined, undefined, next)");
    // A press that opened the scrubber owns its trailing click even when the
    // scrub was abandoned — cancelling must not fall through to "start anyway".
    expect(source).toContain("if (!gestureOpenedRef.current) return");
  });

  test("hold-to-scrub panel uses a thick track and rounded-square thumb with morphing accent", async () => {
    const source = await app();
    // The panel is owned by the shared gesture engine, so the pill and Start
    // raise the exact same surface.
    const start = source.indexOf("function useThinkingScrub(");
    const end = source.indexOf("function ComposerThinkingControl(", start);
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
    // Dedicated solid panel class — not a faint utility bg over the composer.
    expect(control).toContain('className="thinking-scrubber-panel"');
    expect(css).toContain(".thinking-scrubber-panel");
    expect(css).toContain("background: #1c1c1e");
    // Every stop is named while the labels fit; past 5 levels the row falls
    // back to the two endpoints (not Faster/Deeper) so they never overlap.
    expect(control).toContain(
      "levels.length <= 5 ? levels : [levels[0]!, levels[levels.length - 1]!]",
    );
    expect(control).toContain('data-active={level === previewLevel ? "" : undefined}');
    expect(control).toContain('className="thinking-scrubber-ends"');
    expect(css).toContain(".thinking-scrubber-ends");
    expect(css).toContain(".thinking-scrubber-ends > span[data-active]");
    // One tick per level, pinned to the thumb's travel range, so the number of
    // stops stays readable even when the names collapse to endpoints.
    expect(control).toContain('className="thinking-scrubber-ticks"');
    expect(control).toContain(
      "left: `calc(var(--thinking-thumb-half) + ${",
    );
    expect(css).toContain(".thinking-scrubber-ticks");
    // Caption names what the gesture will do — "Thinking" vs "Start thinking".
    expect(control).toContain('className="thinking-scrubber-caption-label"');
    expect(css).toContain(".thinking-scrubber-caption");
    // Panel flips above/below the trigger and animates from the right edge.
    expect(control).toContain('placement === "above"');
    expect(control).toContain('"origin-bottom slide-in-from-bottom-2"');
    expect(control).toContain('"origin-top slide-in-from-top-2"');
    expect(css).toContain("padding-inline: 0");
    expect(css).toContain("inset-inline: 0");
    expect(control).not.toContain(">Faster</span>");
    expect(control).not.toContain(">Deeper</span>");
    // Scrub panel no longer titles itself "Thinking" — only the composer pill does.
    expect(control).not.toContain('text-muted-foreground">Thinking</span>');
    // Dot markers replaced by the pixel-matrix track + chunky squircle thumb.
    expect(control).not.toContain("rounded-full bg-popover ring-2");
    expect(control).not.toContain("from-sky-400/35 via-violet-400/55");
    expect(source).toContain("THINKING_ACCENT_STOPS");
    expect(source).toContain("function thinkingAccentColor(");

    expect(css).toContain(".thinking-scrubber-track");
    expect(css).toContain(".thinking-scrubber-matrix");
    expect(css).toContain(".thinking-scrubber-thumb");
    expect(css).toContain("--thinking-matrix-mask");
    expect(css).toContain("border-radius: 0.4rem");
    expect(css).toContain("--thinking-track-height: 1.7rem");
    expect(css).toContain("--thinking-thumb: 1.3rem");
    expect(css).toContain("background: transparent");
    expect(css).toContain("box-shadow: none");
    expect(css).toContain("rgba(0, 122, 255");
    expect(css).toContain("rgba(175, 82, 222");
    expect(css).toContain("rgba(232, 121, 249");
  });
});
