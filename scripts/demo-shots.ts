// Screenshot driver for the artifacts + activity demo (worktree server :8899).
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8899";
const OUT = "/tmp/lfg-demo";

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1000, height: 900 },
  colorScheme: "dark",
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
// Profile picker on first load.
const benny = page.getByText("Benny").first();
if (await benny.isVisible().catch(() => false)) {
  await benny.click();
  await page.waitForTimeout(2000);
}
await page.screenshot({ path: `${OUT}-home.png` });

// Open the dashboard demo session's chat.
await page.getByText("Fleet metrics dashboard").first().click();
await page.waitForTimeout(2500);
const iframe = page.locator('iframe[title="Fleet dashboard"]');
await iframe.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}-chat.png` });

// Activity tab.
await page.getByRole("button", { name: "Activity" }).first().click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}-activity.png` });

await browser.close();
console.log("done");
