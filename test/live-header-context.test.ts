import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const app = () => readFile("web/src/App.tsx", "utf8");
const sonner = () => readFile("web/src/components/ui/sonner.tsx", "utf8");
const styles = () => readFile("web/src/index.css", "utf8");

describe("contextual mobile Live header", () => {
  test("morphs the logo into a personalized notification target after two seconds", async () => {
    const source = await app();
    expect(source).toContain("setShowHeaderBrandIntro(false), 2000");
    expect(source).toContain("function LiveHeaderContext({");
    expect(source).toContain("const welcomeMessage = `Welcome, ${firstName}`");
    expect(source).toContain('`${busyCount} agent${busyCount === 1 ? "" : "s"} building`');
    expect(source).toContain(': "Ready to build"');
    expect(source).toContain("setShowAmbientStatus((current) => !current)");
    expect(source).toContain('getPropertyValue("--text-swap-dur")');
    expect(source).toContain('ambientSwapState === "exit" && "is-exit"');
    expect(source).toContain('ambientSwapState === "enter" && "is-enter-start"');
    expect(source).toContain("<ShimmerText>{headline}</ShimmerText>");
    expect(source).toContain("const showCard = intro || questionCount > 0;");
    expect(source).toContain("surface={showCard}");
    expect(source).toContain('showCard && "glass-island"');
    expect(source).toContain('questionCount ? "px-3" : "px-1"');
    expect(source).toContain('? "text-[12px] font-semibold"');
    expect(source).toContain('? "text-[12px] font-medium"');
    expect(source).toContain(': "text-[14px] font-semibold"');
    expect(source).toContain("{questionCount ? (");
    expect(source).toContain('<Bell className="size-4 shrink-0 fill-primary/15 text-primary" aria-hidden />');
    expect(source).toContain("{detail ? (");
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

  test("uses the center surface for urgent questions on mobile", async () => {
    const source = await app();
    expect(source).toContain("const { questions } = useAsk();");
    expect(source).toContain('"Tap to open notifications"');
    expect(source).toContain("embedded ? null : isMobile ? null");
  });
});

describe("toast placement", () => {
  test("mounts every toast stack at the top center below mobile chrome", async () => {
    const source = await app();
    expect(source).not.toContain('<Toaster position="bottom-center" />');
    expect(source.match(/<Toaster position="top-center" \/>/g)?.length).toBe(2);
    expect(await sonner()).toContain(
      'top: "calc(var(--lfg-mobile-header-height) + 0.5rem)"',
    );
  });

  test("dismisses top-anchored toasts back through the top edge", async () => {
    const wrapper = await sonner();
    expect(wrapper).toContain(
      'const edgeSwipeDirection = position.startsWith("top") ? "top" : "bottom"',
    );
    expect(wrapper).toContain(
      "swipeDirections={swipeDirections ?? [edgeSwipeDirection]}",
    );
    expect(await styles()).toContain(
      '[data-y-position="top"][data-removed="true"][data-front="false"][data-expanded="false"]',
    );
    expect(await styles()).toContain("--y: translateY(-40%);");
  });
});
