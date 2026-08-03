import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const app = () => readFile("web/src/App.tsx", "utf8");
const sonner = () => readFile("web/src/components/ui/sonner.tsx", "utf8");

describe("contextual mobile Live header", () => {
  test("morphs the logo into a personalized notification target after two seconds", async () => {
    const source = await app();
    expect(source).toContain("setShowHeaderBrandIntro(false), 2000");
    expect(source).toContain("function LiveHeaderContext({");
    expect(source).toContain("`Welcome, ${firstName}`");
    expect(source).toContain('"What are we building today?"');
    expect(source).toContain("const showCard = intro || questionCount > 0;");
    expect(source).toContain("surface={showCard}");
    expect(source).toContain('showCard && "glass-island"');
    expect(source).toContain('onOpenNotifications={() => setTab("notifications")}');
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
});
