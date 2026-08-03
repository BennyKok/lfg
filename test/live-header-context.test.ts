import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const app = () => readFile("web/src/App.tsx", "utf8");
const sonner = () => readFile("web/src/components/ui/sonner.tsx", "utf8");
const styles = () => readFile("web/src/index.css", "utf8");

describe("contextual mobile Live header", () => {
  test("rests on a larger welcome and only visits status while work is moving", async () => {
    const source = await app();
    expect(source).toContain("setShowHeaderBrandIntro(false), 2000");
    expect(source).toContain("function LiveHeaderContext({");
    expect(source).toContain("const welcomeMessage = `Welcome, ${firstName}`");
    expect(source).toContain('`${busyCount} agent${busyCount === 1 ? "" : "s"} building`');
    expect(source).toContain("const actionInMotion = busyCount > 0;");
    expect(source).toContain("const dwellMs = showAmbientStatus ? 2800 : 8000;");
    expect(source).toContain("intro || questionCount || !actionInMotion");
    expect(source).toContain("setShowAmbientStatus((current) => !current)");
    expect(source).toContain('getPropertyValue("--text-swap-dur")');
    expect(source).toContain('ambientSwapState === "exit" && "is-exit"');
    expect(source).toContain('ambientSwapState === "enter" && "is-enter-start"');
    expect(source).toContain("<ShimmerText>{headline}</ShimmerText>");
    expect(source).toContain("const showCard = intro;");
    expect(source).toContain("surface={showCard}");
    expect(source).toContain('showCard && "glass-island"');
    expect(source).toContain('"flex min-w-0 items-center px-1 transition-all duration-300 ease-ios"');
    expect(source).toContain('? "text-[14px] font-semibold"');
    expect(source).toContain(": actionInMotion && showAmbientStatus");
    expect(source).toContain('? "text-[12px] font-medium"');
    expect(source).toContain(': "text-[16px] font-semibold"');
    expect(source).not.toContain('<Bell className="size-4 shrink-0 fill-primary/15 text-primary" aria-hidden />');
    expect(source).not.toContain("{detail ? (");
    expect(source).toContain('onOpenNotifications={() => setTab("notifications")}');
  });

  test("ships motion-safe text swap and shimmer treatments", async () => {
    const styleSource = await styles();
    expect(styleSource).toContain(".t-text-swap.is-exit");
    expect(styleSource).toContain(".t-text-swap.is-enter-start");
    expect(styleSource).toContain("--text-swap-dur: 150ms");
    expect(styleSource).toContain(".lfg-shimmer-text::before");
    expect(styleSource).toContain("animation: none !important");
  });

  test("keeps urgent questions accessible without restoring a badge", async () => {
    const source = await app();
    expect(source).toContain("const { questions } = useAsk();");
    expect(source).toContain("Tap to open notifications");
    expect(source).toContain("const showCard = intro;");
    expect(source).toContain("embedded ? null : isMobile ? null");
  });
});

describe("toast placement", () => {
  test("mounts toasts at the bottom on desktop and below the chrome on mobile", async () => {
    const source = await app();
    expect(
      source.match(/<Toaster position=\{isMobile \? "top-center" : "bottom-center"\} \/>/g)
        ?.length,
    ).toBe(2);
    expect(await sonner()).toContain(
      'top: "calc(var(--lfg-mobile-header-height) + 0.5rem)"',
    );
  });

  test("folds and dismisses mobile top toasts back toward the top edge", async () => {
    const wrapper = await sonner();
    const css = await styles();
    expect(wrapper).toContain(
      'const edgeSwipeDirection = position.startsWith("top") ? "top" : "bottom"',
    );
    expect(wrapper).toContain(
      "swipeDirections={swipeDirections ?? [edgeSwipeDirection]}",
    );
    expect(css).toContain(
      '[data-y-position="top"][data-expanded="false"][data-front="false"]',
    );
    expect(css).toContain("--lift-amount: calc(-1 * var(--gap)) !important;");
    expect(css).toContain(
      '[data-y-position="top"][data-removed="true"][data-front="false"][data-expanded="false"]',
    );
    expect(css).toContain("--y: translateY(-40%);");
  });
});
