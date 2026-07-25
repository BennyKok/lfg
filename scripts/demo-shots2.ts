import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8899";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, colorScheme: "dark" });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const benny = page.getByText("Benny").first();
if (await benny.isVisible().catch(() => false)) {
  await benny.click();
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(2000);

// Focused crop of the dashboard-artifact chat card.
await page.screenshot({ path: "/tmp/lfg-demo-artifact.png", clip: { x: 505, y: 205, width: 490, height: 570 } });

// Activity tab.
await page.getByRole("button", { name: "Activity" }).first().click();
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/lfg-demo-activity.png" });

await browser.close();
console.log("done");
