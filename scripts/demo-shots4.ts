import { chromium } from "playwright";

const browser = await chromium.launch();

// Desktop feed.
const desktop = await browser.newPage({ viewport: { width: 1000, height: 1250 }, colorScheme: "dark" });
await desktop.goto("http://127.0.0.1:8899", { waitUntil: "networkidle" });
await desktop.waitForTimeout(1500);
const benny = desktop.getByText("Benny").first();
if (await benny.isVisible().catch(() => false)) {
  await benny.click();
  await desktop.waitForTimeout(1500);
}
await desktop.getByRole("button", { name: "Shipped" }).first().click();
await desktop.waitForTimeout(3000);
// Type (but don't send) a reply so the comment affordance is visible.
await desktop.getByPlaceholder("Reply to codex…").first().fill("Love it — can the artifact card collapse?");
await desktop.screenshot({ path: "/tmp/lfg-ship-desktop.png" });
await desktop.close();

// Mobile: swipe from Live onto the Shipped page, then send a reply.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark",
  hasTouch: true,
  isMobile: true,
});
const mobile = await ctx.newPage();
await mobile.goto("http://127.0.0.1:8899", { waitUntil: "networkidle" });
await mobile.waitForTimeout(1500);
const benny2 = mobile.getByText("Benny").first();
if (await benny2.isVisible().catch(() => false)) {
  await benny2.click();
  await mobile.waitForTimeout(1500);
}
// Swipe left (right→left) on the main area: Live → Shipped.
await mobile.touchscreen.tap(195, 400);
await mobile.waitForTimeout(300);
const cdp = await ctx.newCDPSession(mobile);
const swipe = async () => {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 330, y: 420 }] });
  for (let x = 330; x >= 120; x -= 30) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 420 }] });
    await mobile.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
await swipe();
await mobile.waitForTimeout(2500);
// Send a real reply to the agent on the updated post.
const box = mobile.getByPlaceholder("Reply to codex…").first();
if (await box.isVisible().catch(() => false)) {
  await box.fill("Nice. Also add a compact list density toggle please");
  await mobile.getByLabel("Send reply to the agent").first().click();
  await mobile.waitForTimeout(1200);
}
await mobile.screenshot({ path: "/tmp/lfg-ship-mobile.png" });
await ctx.close();

await browser.close();
console.log("done");
