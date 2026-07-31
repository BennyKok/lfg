// The Notification Center absorbed the Ask page: agent questions are a form of
// notification, so they are answered in the feed instead of on a page of their
// own. These are structural guards — the surfaces live in a 20k-line component,
// so the cheap thing to pin is that the wiring exists and the retired pieces
// are actually gone rather than merely unreachable.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const app = () => readFile("web/src/App.tsx", "utf8");
const askCenter = () => readFile("web/src/components/ask-center.tsx", "utf8");

describe("questions live inside the Notification Center", () => {
  test("the feed renders questions as answerable cells", async () => {
    const source = await app();
    expect(source).toContain("<QuestionNotification key={q.id} q={q} />");
    // Read from the app-wide provider, not fetched a second time by the page.
    expect(source).toContain("const { questions } = useAsk();");
    expect(source).toContain("Needs you");
  });

  test("the ask page is gone, not just unlinked", async () => {
    const source = await app();
    const center = await askCenter();
    expect(source).not.toContain("<AskPage");
    expect(source).not.toContain('tab === "ask"');
    expect(center).not.toContain("export function AskPage");
    // The floating card and its collapse state were dead before this change.
    expect(center).not.toContain("export function AskCenter");
    expect(center).not.toContain("export function useAskCount");
    expect(center).not.toContain("setCollapsed");
  });

  test("the urgency badge opens the Notification Center", async () => {
    const source = await app();
    expect(source).toContain('onOpen={() => setTab("notifications")}');
  });
});

describe("the notification row is compact", () => {
  test("no follow-up button: forking belongs in the session", async () => {
    const source = await app();
    expect(source).not.toContain("setFollowingUp");
    expect(source).not.toContain("onFollowUpCreated");
    // The fork dialog's follow-up mode had exactly one caller — this button.
    expect(source).not.toContain('mode="follow-up"');
    expect(source).not.toContain('mode?: "fork" | "follow-up"');
    // The only surviving "Follow up" is an unrelated manage-sessions template.
    expect(source.match(/Follow up/g)?.length).toBe(1);
    expect(source).toContain('label: "Follow up commits/PRs"');
  });

  test("media is a trailing thumbnail, not a full-width grid", async () => {
    const source = await app();
    expect(source).toContain("function ShipMediaThumb(");
    expect(source).toContain("post.mediaTotal ?? post.mediaItems.length");
    // The full-width per-post media renderer is retired.
    expect(source).not.toContain("function ShipMedia({");
  });

  test("rows are grouped by day so they can drop their date", async () => {
    const source = await app();
    expect(source).toContain("function notificationDayLabel(");
    expect(source).toContain("const postGroups = useMemo(");
  });

  test("the two-line body is plain text, not a markdown tree per row", async () => {
    const source = await app();
    expect(source).toContain("line-clamp-2");
    expect(source).toContain("{stripMd(post.summary)}");
  });
});

describe("one poller for the shipped head", () => {
  test("both surfaces subscribe instead of running their own interval", async () => {
    const source = await app();
    const feed = await readFile("web/src/lib/shipped-feed.ts", "utf8");
    expect(feed).toContain("export function subscribeShippedHead");
    expect(feed).toContain("if (inFlight) return inFlight;");
    // Neither consumer may re-introduce a private interval on this endpoint.
    expect(source).not.toContain('api<{ posts: ShipPost[] }>("/api/shipped?limit=25"');
    expect(source).not.toContain("`/api/shipped?limit=${FEED_PAGE}`");
    expect(source.match(/subscribeShippedHead<ShipPost>/g)?.length).toBe(2);
  });

  test("a hidden tab stops polling", async () => {
    const feed = await readFile("web/src/lib/shipped-feed.ts", "utf8");
    expect(feed).toContain('document.visibilityState === "visible"');
    expect(feed).toContain("if (listeners.size === 0)");
    expect(feed).toContain("stopTimer();");
  });
});

describe("the feed ships only what it renders", () => {
  test("the server caps media and clamps the summary", async () => {
    const shipped = await readFile("src/shipped.ts", "utf8");
    expect(shipped).toContain("MAX_FEED_MEDIA");
    expect(shipped).toContain("summaryTruncated");
    // Storage keeps the full summary; only the feed response is clamped.
    expect(shipped).toContain("slice(0, 2000)");
  });

  test("the merged feed is indexed, not rebuilt per request", async () => {
    const shipped = await readFile("src/shipped.ts", "utf8");
    expect(shipped).toContain("mergedCache");
    expect(shipped).toContain("function readMergedPosts(");
  });
});
