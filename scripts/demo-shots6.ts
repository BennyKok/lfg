import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1250 }, colorScheme: "dark" });
await page.goto("http://127.0.0.1:8899", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const benny = page.getByText("Benny").first();
if (await benny.isVisible().catch(() => false)) {
  await benny.click();
  await page.waitForTimeout(1500);
}
await page.getByRole("button", { name: "Shipped" }).first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/lfg-ship-v4-feed.png" });

// Open the ENDED session's post → read-only transcript sheet.
await page.getByText("Live fleet dashboard is up").first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/lfg-ship-v4-readonly.png" });
await browser.close();
console.log("done");
