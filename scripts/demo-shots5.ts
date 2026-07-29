import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark",
  hasTouch: true,
  isMobile: true,
});
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8899", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const benny = page.getByText("Benny").first();
if (await benny.isVisible().catch(() => false)) {
  await benny.click();
  await page.waitForTimeout(2000);
}
// Swipe right→left over the main area: Live → Shipped.
const cdp = await ctx.newCDPSession(page);
await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 350, y: 500 }] });
for (let x = 350; x >= 100; x -= 25) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 500 }] });
  await page.waitForTimeout(16);
}
await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await page.waitForTimeout(2500);

const onShipped = await page.getByText("what your agents finished").isVisible().catch(() => false);
if (!onShipped) {
  console.log("swipe missed — falling back to nav tap");
  await page.getByRole("button", { name: "Shipped" }).first().click();
  await page.waitForTimeout(2000);
}
const box = page.getByPlaceholder("Reply to codex…").first();
if (await box.isVisible().catch(() => false)) {
  await box.fill("Nice. Also add a compact list density toggle please");
  await page.getByLabel("Send reply to the agent").first().click();
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: "/tmp/lfg-ship-mobile.png" });
await ctx.close();
await browser.close();
console.log("done, swiped:", onShipped);
