import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 1200 }, colorScheme: "dark" });

await page.goto("http://127.0.0.1:8899", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const benny = page.getByText("Benny").first();
if (await benny.isVisible().catch(() => false)) {
  await benny.click();
  await page.waitForTimeout(1500);
}
await page.getByRole("button", { name: "Shipped" }).first().click();
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/lfg-shipped.png" });
await browser.close();
console.log("done");
