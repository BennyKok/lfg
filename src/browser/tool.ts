// Agent-side reuse of saved browser logins. Given a profile id captured by an
// interactive login session (see ./session.ts), launch a *headless* Chromium
// context that replays the profile's storageState so the agent acts as the
// logged-in user. testProfile is a cheap liveness probe to tell whether a saved
// login is still valid.
import { loadChromium } from "../native-deps.ts";
import { getProfile, profileStatePath, touchProfile } from "./profiles.ts";

// Open a headless browser already carrying the profile's cookies/localStorage.
// Caller owns the returned handles and must close `browser` when done.
export async function launchWithProfile(id: string): Promise<{
  browser: any;
  context: any;
  page: any;
}> {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: profileStatePath(id),
  });
  const page = await context.newPage();
  await touchProfile(id);
  return { browser, context, page };
}

// Probe whether a saved login is still valid. Navigates to `url` (or the
// profile's first known origin), then heuristically decides "logged in" from the
// final URL: auth/login/signin landing pages mean the session was rejected.
export async function testProfile(
  id: string,
  url?: string,
): Promise<{ loggedIn: boolean; title: string; finalUrl: string }> {
  let browser: any;
  try {
    const launched = await launchWithProfile(id);
    browser = launched.browser;
    const { page } = launched;

    let target = url;
    if (!target) {
      const meta = await getProfile(id);
      target = meta?.origins?.[0];
    }
    if (!target) {
      return { loggedIn: false, title: "", finalUrl: "" };
    }

    try {
      await page.goto(target, { waitUntil: "domcontentloaded" });
    } catch {
      // navigation may partially fail — still inspect whatever we landed on
    }

    let finalUrl = "";
    let title = "";
    try {
      finalUrl = page.url();
    } catch {
      finalUrl = "";
    }
    try {
      title = await page.title();
    } catch {
      title = "";
    }

    // Bounced to an auth page => the stored session is no longer good.
    const loggedIn = !/\/(login|signin|sign-in|auth)\b/i.test(finalUrl);
    return { loggedIn, title, finalUrl };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // already closed
      }
    }
  }
}
