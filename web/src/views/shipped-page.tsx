// The shipped feed and the artifact gallery, in their own chunk.
//
// Two full pages that only render when you open the Shipped or Artifacts tab,
// and neither is on the path to first paint. App.tsx loads this lazily; the
// shared pieces both sides need live in lib/session-ui.
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CheckCheck,
  ChevronRight,
  LayoutDashboard,
  Loader2,
  MessageSquareText,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { AskProvider, QuestionNotification, stripMd, useAsk } from "../components/ask-center";
import { AuthenticatedArtifactImage } from "../components/authenticated-artifact";
import { NativeArtifactThumbnail } from "../components/native-artifact";
import { Button } from "@/components/ui/button";
import { useAppDialog } from "@/components/ui/app-dialog";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  ARTIFACTS_GALLERY_KEY,
  SHIPPED_FEED_KEY,
  readFeedCache,
  writeFeedCache,
} from "../lib/feed-cache";
import { api } from "../lib/lfg-client";
import {
  NOTIFICATION_READ_STATE_EVENT,
  markAllNotificationsRead,
  markNotificationRead,
  notificationIsUnread,
  notificationReadState,
  shippedNotificationId,
  type NotificationReadState,
} from "../lib/notification-center";
import { acknowledgePushNotifications } from "../lib/push";
import { SHIPPED_HEAD_LIMIT, subscribeShippedHead } from "../lib/shipped-feed";
import {
  ArtifactViewerContext,
  FEED_PAGE,
  GALLERY_PAGE,
  agentIconAlt,
  agentIconSrc,
  timeAgo,
  type ViewerArtifact,
} from "../lib/session-ui";
// Types only — erased at build time, so this does not create a runtime cycle
// back into the entry chunk.
import type { Agent, GalleryArtifact, ShipMediaItem, ShipPost, Session } from "../App";


function GalleryTilePreview({
  path,
  cacheKey,
  children,
}: {
  path: string;
  cacheKey?: string | number;
  children?: React.ReactNode;
}) {
  return (
    <div className="relative h-32 w-full overflow-hidden bg-background">
      <NativeArtifactThumbnail path={path} cacheKey={cacheKey} className="h-full w-full" />
      {children}
    </div>
  );
}

// A notification's media, as a trailing thumbnail rather than a full-width
// grid. This is the iOS notification shape: the attachment is a hint at what
// happened, not the payload — one 52px square on the right of the row, tapped
// to open the real thing. A post with four screenshots used to add ~350px of
// feed height; it now adds none.

function ShipMediaThumb({
  items,
  total,
  onExpand,
}: {
  items: ShipMediaItem[];
  total: number;
  onExpand?: (artifact: ViewerArtifact) => void;
}) {
  const item = items[0];
  if (!item) return null;
  const extra = Math.max(0, total - 1);
  const open = () =>
    onExpand?.({
      url: item.url,
      kind: item.kind,
      caption: item.caption,
      name: item.name,
      version: item.version,
      cacheKey: item.updatedAt,
    });
  return (
    <button
      type="button"
      onClick={open}
      aria-label={`Open ${item.caption || item.name}`}
      title={item.caption || item.name}
      className="relative size-[52px] shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted transition-transform active:scale-[0.97]"
    >
      {item.kind === "image" ? (
        <AuthenticatedArtifactImage
          path={item.url}
          alt={item.caption || item.name}
          thumb
          className="size-full object-cover"
        />
      ) : item.kind === "html" ? (
        // Deliberately an icon, not a live preview. A document scaled into a
        // 52px box is two words of giant text — unreadable, and it costs a
        // fetch + parse per row. The Artifacts page is where previews belong.
        <span className="flex size-full items-center justify-center bg-primary/10 text-primary">
          <LayoutDashboard className="size-4" />
        </span>
      ) : (
        <span className="flex size-full items-center justify-center bg-black/80 text-white/80">
          <Play className="size-4" />
        </span>
      )}
      {extra > 0 ? (
        <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[9px] font-semibold text-white">
          +{extra}
        </span>
      ) : null}
    </button>
  );
}

// Day buckets for the feed, in the phone-notification idiom: today and
// yesterday are named, everything older is dated. Grouping is what lets the
// rows themselves drop their date entirely and show just a time delta.

function notificationDayLabel(ts: number, now: number): string {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diffDays = Math.round((day(now) - day(ts)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

// Page sizes for the Shipped feed and the artifacts gallery: both load one
// page up front and grow via "load more" instead of fetching everything.

// The Shipped channel: a showcase feed of finished work, posted by agents via
// lfg_ship. Media are ordinary artifacts (image / video / live html), so this
// page is purely presentational.
//
// List data is stale-while-revalidated from `feed-cache` so a revisit paints the
// last-known page instantly; when the parent keeps this component mounted
// (`active=false` while hidden) we also skip the poll so a background tab is
// free, and revalidate once when it becomes active again.

export default function ShippedPage({
  onOpenSession,
  onOpenArtifactSession,
  onReviewSession,
  liveSessionIds,
  notificationIdentity,
  artifactsOnly = false,
  active = true,
}: {
  onOpenSession: (sessionId: string) => void;
  onOpenArtifactSession?: (artifact: GalleryArtifact) => void;
  onReviewSession?: (post: ShipPost) => void;
  liveSessionIds: Set<string>;
  notificationIdentity?: string | null;
  artifactsOnly?: boolean;
  active?: boolean;
}) {
  // Shipped and Artifacts are separate virtual pages. This shared loader keeps
  // their paging/realtime behavior aligned without exposing a nested toggle.
  const view: "feed" | "artifacts" = artifactsOnly ? "artifacts" : "feed";
  const cachedGallery = artifactsOnly ? readFeedCache<GalleryArtifact>(ARTIFACTS_GALLERY_KEY) : null;
  const cachedPosts = !artifactsOnly ? readFeedCache<ShipPost>(SHIPPED_FEED_KEY) : null;

  const [posts, setPosts] = useState<ShipPost[] | null>(() => cachedPosts?.items ?? null);
  const [postsTotal, setPostsTotal] = useState(() => cachedPosts?.total ?? 0);
  const [postsBusy, setPostsBusy] = useState(false);
  const [notificationReads, setNotificationReads] = useState<NotificationReadState | null>(() =>
    artifactsOnly ? null : notificationReadState(notificationIdentity),
  );
  const [markingNotificationsRead, setMarkingNotificationsRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Agent questions are notifications too, and <AskProvider> already polls for
  // them app-wide (it feeds the nav badge). Reading them from context instead
  // of fetching here keeps the page at one request per tick.
  const { questions, busy: asksBusy, dismissAll: dismissAllQuestions } = useAsk();
  // Two-step, because this one is bulk and irreversible: every asking agent
  // stops waiting. Single dismissals stay one tap.
  const [confirmDismissAll, setConfirmDismissAll] = useState(false);
  // Never leave a primed destructive button behind when the stack changes under
  // it — the count in the label would be answering for a different set.
  useEffect(() => {
    setConfirmDismissAll(false);
  }, [questions.length]);
  const [gallery, setGallery] = useState<GalleryArtifact[] | null>(() => cachedGallery?.items ?? null);
  const [galleryTotal, setGalleryTotal] = useState(() => cachedGallery?.total ?? 0);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [refreshingArtifactId, setRefreshingArtifactId] = useState<string | null>(null);
  const [deletingArtifactId, setDeletingArtifactId] = useState<string | null>(null);
  // "Artifact" means the interactive HTML document. Images and recordings
  // remain media in transcripts/Shipped and do not appear on this page.
  const galleryKindParam = "&kind=html";
  // How many items are currently on screen — the polling refresh re-fetches
  // exactly that window so "load more" pages survive the refresh.
  const galleryLen = useRef(Math.max(GALLERY_PAGE, cachedGallery?.items.length ?? 0));
  const postsLen = useRef(Math.max(FEED_PAGE, cachedPosts?.items.length ?? 0));
  const openArtifact = useContext(ArtifactViewerContext);
  const appDialog = useAppDialog();

  useEffect(() => {
    if (view !== "feed") return;
    setNotificationReads(notificationReadState(notificationIdentity));
  }, [notificationIdentity, view]);

  // Existing Shipped history predates the Notification Center. Establish a
  // migration baseline on first visit so years of finished work do not appear
  // as newly unread; only revisions arriving after this point raise the count.
  useEffect(() => {
    if (view !== "feed" || posts === null || notificationReads) return;
    const newestVisible = posts.reduce((latest, post) => Math.max(latest, post.ts), Date.now());
    setNotificationReads(markAllNotificationsRead(notificationIdentity, newestVisible));
  }, [notificationIdentity, notificationReads, posts, view]);

  // `storage` covers other tabs; the custom event covers other components in
  // THIS tab (it was dispatched with nothing listening, so an in-tab write
  // elsewhere never repainted the feed).
  useEffect(() => {
    if (view !== "feed") return;
    const sync = () => setNotificationReads(notificationReadState(notificationIdentity));
    window.addEventListener("storage", sync);
    window.addEventListener(NOTIFICATION_READ_STATE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(NOTIFICATION_READ_STATE_EVENT, sync);
    };
  }, [notificationIdentity, view]);
  useEffect(() => {
    if (view !== "artifacts") return;
    let alive = true;
    const load = async () => {
      try {
        // One page per tick, same reasoning as the feed poll above: new and
        // refreshed artifacts land at the head, so re-listing the whole loaded
        // window every 20s buys nothing.
        const data = await api<{ artifacts: GalleryArtifact[]; total?: number }>(
          `/api/artifacts?limit=${GALLERY_PAGE}${galleryKindParam}`,
          { cache: "no-store" },
        );
        if (!alive) return;
        // Normalize once: a proxied workspace can answer 2xx without the array,
        // and everything below spreads/maps it.
        const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
        const total = data.total ?? artifacts.length;
        setGallery((prev) => {
          const freshIds = new Set(artifacts.map((a) => a.id));
          const tail = (prev ?? []).filter((a) => !freshIds.has(a.id));
          const merged = [...artifacts, ...tail];
          galleryLen.current = Math.max(GALLERY_PAGE, merged.length);
          writeFeedCache(ARTIFACTS_GALLERY_KEY, merged, total);
          return merged;
        });
        setGalleryTotal(total);
      } catch {
        // Keep a cached paint if we have one; only fall to empty when nothing
        // has ever loaded.
        if (alive) setGallery((g) => g ?? []);
      }
    };
    void load();
    if (!active) {
      return () => {
        alive = false;
      };
    }
    const interval = setInterval(() => void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [view, active]);

  const loadMoreGallery = async () => {
    if (galleryBusy) return;
    setGalleryBusy(true);
    try {
      const data = await api<{ artifacts: GalleryArtifact[]; total?: number }>(
        `/api/artifacts?limit=${GALLERY_PAGE}&offset=${galleryLen.current}${galleryKindParam}`,
        { cache: "no-store" },
      );
      setGallery((g) => {
        const seen = new Set((g ?? []).map((a) => a.id));
        const merged = [...(g ?? []), ...data.artifacts.filter((a) => !seen.has(a.id))];
        galleryLen.current = merged.length;
        writeFeedCache(ARTIFACTS_GALLERY_KEY, merged, data.total ?? galleryTotal);
        return merged;
      });
      setGalleryTotal((t) => {
        const next = data.total ?? t;
        return next;
      });
    } catch {
      // Leave the current page as-is; the next tap retries.
    } finally {
      setGalleryBusy(false);
    }
  };

  const deleteGalleryArtifact = async (artifact: GalleryArtifact) => {
    const label = artifact.title || artifact.caption || artifact.name;
    const confirmed = await appDialog.confirm({
      title: `Delete ${label}?`,
      description: "This permanently removes the artifact and stops its automatic refresh schedule.",
      confirmLabel: "Delete artifact",
      destructive: true,
    });
    if (!confirmed) return;
    setDeletingArtifactId(artifact.id);
    try {
      await api(
        `/api/sessions/${encodeURIComponent(artifact.sessionId ?? "")}/artifacts/${encodeURIComponent(artifact.id)}`,
        {
          method: "DELETE",
          headers: { "X-LFG-Session-ID": artifact.sessionId ?? "" },
        },
      );
      setGallery((current) => {
        const next = current?.filter((item) => item.id !== artifact.id) ?? null;
        if (next) writeFeedCache(ARTIFACTS_GALLERY_KEY, next, Math.max(0, galleryTotal - 1));
        return next;
      });
      setGalleryTotal((total) => Math.max(0, total - 1));
      galleryLen.current = Math.max(0, galleryLen.current - 1);
      toast.success("Artifact deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete artifact");
    } finally {
      setDeletingArtifactId(null);
    }
  };

  const refreshGalleryArtifact = async (artifact: GalleryArtifact) => {
    if (!artifact.sessionId || artifact.refreshEnabled === undefined) return;
    setRefreshingArtifactId(artifact.id);
    try {
      const data = await api<{
        artifact: {
          updatedAt?: number;
          version?: number;
          size?: number;
          refresh?: {
            enabled?: boolean;
            status?: GalleryArtifact["refreshStatus"];
            lastSuccessAt?: number;
          };
        };
      }>(
        `/api/sessions/${encodeURIComponent(artifact.sessionId)}/artifacts/html/${encodeURIComponent(artifact.id)}/refresh`,
        {
          method: "POST",
          headers: { "X-LFG-Session-ID": artifact.sessionId },
        },
      );
      setGallery((current) => {
        const next = current?.map((item) => item.id === artifact.id
          ? {
              ...item,
              ts: data.artifact.updatedAt ?? item.ts,
              version: data.artifact.version ?? item.version,
              size: data.artifact.size ?? item.size,
              lastRefreshedAt: data.artifact.refresh?.lastSuccessAt ?? item.lastRefreshedAt,
              refreshStatus: data.artifact.refresh?.status ?? item.refreshStatus,
              refreshEnabled: data.artifact.refresh?.enabled ?? item.refreshEnabled,
            }
          : item) ?? null;
        if (next) writeFeedCache(ARTIFACTS_GALLERY_KEY, next, galleryTotal);
        return next;
      });
      toast.success("Artifact refreshed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't refresh artifact");
    } finally {
      setRefreshingArtifactId(null);
    }
  };

  // Only ever the HEAD page is polled, not everything loaded so far: freshness
  // arrives at the top, so re-downloading 75 hydrated posts to discover one new
  // one is pure waste. The head itself comes from the shared poller in
  // lib/shipped-feed, which the Live sidebar reads too — one request per tick
  // for the whole app instead of one per surface.
  useEffect(() => {
    if (view !== "feed" || !active) return;
    return subscribeShippedHead<ShipPost>((result) => {
      if (!result.ok) {
        // Only meaningful when nothing has ever painted; otherwise the stale
        // page stays up and the next tick retries.
        setPosts((prev) => {
          if (prev === null) setError(result.error);
          return prev;
        });
        return;
      }
      setPosts((prev) => {
        // Splice the fresh head onto the tail we already hold, keyed by id so a
        // post that a newer ship pushed off the first page is not duplicated —
        // and so the tail keeps its order when the head grows.
        const freshIds = new Set(result.posts.map((p) => p.id));
        const tail = (prev ?? []).filter((p) => !freshIds.has(p.id));
        const merged = [...result.posts, ...tail];
        postsLen.current = Math.max(SHIPPED_HEAD_LIMIT, merged.length);
        writeFeedCache(SHIPPED_FEED_KEY, merged, result.total);
        return merged;
      });
      setPostsTotal(result.total);
      setError(null);
    });
  }, [view, active]);

  const loadMorePosts = async () => {
    if (postsBusy) return;
    setPostsBusy(true);
    try {
      const data = await api<{ posts: ShipPost[]; total?: number }>(
        `/api/shipped?limit=${FEED_PAGE}&offset=${postsLen.current}`,
        { cache: "no-store" },
      );
      setPosts((p) => {
        const seen = new Set((p ?? []).map((x) => x.id));
        const merged = [...(p ?? []), ...data.posts.filter((x) => !seen.has(x.id))];
        postsLen.current = merged.length;
        writeFeedCache(SHIPPED_FEED_KEY, merged, data.total ?? postsTotal);
        return merged;
      });
      setPostsTotal((t) => data.total ?? t);
    } catch {
      // Leave the current page as-is; the next tap retries.
    } finally {
      setPostsBusy(false);
    }
  };

  const unreadPosts =
    posts?.filter((post) =>
      notificationIsUnread(notificationReads, {
        id: shippedNotificationId(post),
        ts: post.ts,
      }),
    ).length ?? 0;

  // Bucket the feed into named days once per posts change. Grouping is what
  // pays for the compact row: the date lives in the section header, so each
  // row only carries a time delta.
  const postGroups = useMemo(() => {
    if (!posts?.length) return [];
    const now = Date.now();
    const groups: Array<{ label: string; items: ShipPost[] }> = [];
    for (const post of posts) {
      const label = notificationDayLabel(post.ts, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(post);
      else groups.push({ label, items: [post] });
    }
    return groups;
  }, [posts]);

  const markPostRead = (post: ShipPost) => {
    if (
      !notificationIsUnread(notificationReads, {
        id: shippedNotificationId(post),
        ts: post.ts,
      })
    ) {
      return;
    }
    setNotificationReads(
      markNotificationRead(notificationIdentity, shippedNotificationId(post)),
    );
  };

  const markAllRead = async () => {
    if (markingNotificationsRead) return;
    setMarkingNotificationsRead(true);
    try {
      const through = Math.max(Date.now(), ...(posts ?? []).map((post) => post.ts));
      setNotificationReads(markAllNotificationsRead(notificationIdentity, through));
      await acknowledgePushNotifications();
      toast.success("Notifications marked read");
    } finally {
      setMarkingNotificationsRead(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-4 pb-10" data-lfg-page-column>
      <div className="flex items-center justify-between px-1">
        <div>
          <h1 className="text-lg font-semibold tracking-[-0.01em]">
            {artifactsOnly ? "Artifacts" : "Notifications"}
          </h1>
          {artifactsOnly ? (
            <p className="mt-0.5 text-xs text-muted-foreground">Interactive reports and live dashboards</p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {questions.length
                ? `${questions.length} waiting on you`
                : unreadPosts
                  ? `${unreadPosts} unread`
                  : "You're all caught up"}
            </p>
          )}
        </div>
        {!artifactsOnly && posts !== null ? (
          // Icon only. It is a rare, undoable housekeeping action — it does not
          // need to be the second-loudest thing on the page.
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Mark all read"
            title="Mark all read — clears the app icon badge"
            disabled={markingNotificationsRead}
            onClick={() => void markAllRead()}
          >
            {markingNotificationsRead ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCheck className="size-4" />
            )}
          </Button>
        ) : null}
      </div>

      {view === "artifacts" ? (
        <>
          {gallery === null ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : gallery.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
              No artifacts yet — agents create them with <code>lfg_publish_artifact</code>.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {gallery.map((a) => (
                <div
                  key={a.id}
                  className="group relative overflow-hidden rounded-xl border border-border bg-card/40 text-left shadow-sm transition-colors hover:border-foreground/20"
                >
                  <button
                    type="button"
                    onClick={() =>
                      openArtifact({
                        url: a.url,
                        kind: a.kind,
                        title: a.title,
                        caption: a.caption,
                        name: a.name,
                        version: a.version,
                        cacheKey: a.ts,
                      })
                    }
                    className="block w-full text-left active:scale-[0.99]"
                  >
                    <GalleryTilePreview path={a.url} cacheKey={a.ts}>
                      {(a.version ?? 1) > 1 ? (
                        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 backdrop-blur dark:text-emerald-400">
                          <span className="size-1.5 rounded-full bg-emerald-500" />
                          live · v{a.version}
                        </span>
                      ) : null}
                    </GalleryTilePreview>
                    <div className="px-2.5 py-2 pr-9">
                      <div className="truncate text-xs font-medium">{a.title || a.caption || a.name}</div>
                      <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                        {a.lastRefreshedAt
                          ? `Refreshed ${timeAgo(a.lastRefreshedAt)}`
                          : `Published ${timeAgo(a.ts)}`}
                      </div>
                    </div>
                  </button>
                  {a.sessionId ? (
                    <button
                      type="button"
                      onClick={() => onOpenArtifactSession?.(a)}
                      aria-label={`Open related session for ${a.title || a.caption || a.name}`}
                      title={a.sessionTitle || a.project || "Open related session"}
                      className="flex w-full items-center gap-1.5 border-t border-border/60 px-2.5 py-2 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
                    >
                      <MessageSquareText className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-left">
                        {a.sessionTitle || a.project || "Related session"}
                      </span>
                      <ChevronRight className="size-3 shrink-0" aria-hidden />
                    </button>
                  ) : null}
                  <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-background/80 backdrop-blur">
                    {a.refreshEnabled !== undefined ? (
                      <button
                        type="button"
                        onClick={() => void refreshGalleryArtifact(a)}
                        disabled={refreshingArtifactId === a.id}
                        aria-label={`Refresh ${a.title || a.caption || a.name}`}
                        className="flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-100 transition-[color,background-color,transform,opacity] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-[0.94] disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                      >
                        <RotateCcw className={cn("size-3.5", refreshingArtifactId === a.id && "animate-spin")} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void deleteGalleryArtifact(a)}
                      disabled={deletingArtifactId === a.id}
                      aria-label={`Delete ${a.title || a.caption || a.name}`}
                      className="flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-100 transition-[color,background-color,transform,opacity] duration-150 hover:bg-destructive/10 hover:text-destructive active:scale-[0.94] disabled:opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                    >
                      {deletingArtifactId === a.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {gallery !== null && gallery.length < galleryTotal ? (
            <button
              type="button"
              onClick={() => void loadMoreGallery()}
              disabled={galleryBusy}
              className="w-full rounded-xl border border-border bg-card/40 px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:opacity-60"
            >
              {galleryBusy ? "Loading…" : `Load more · ${galleryTotal - gallery.length} left`}
            </button>
          ) : null}
        </>
      ) : (
        <>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {posts === null && !error ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      ) : null}

      {/* Time-sensitive first. Borrowed straight from the phone notification
          hierarchy: things blocking a person sit above things that merely
          happened, and they are actionable without leaving the list. */}
      {questions.length ? (
        <section className="space-y-1.5">
          <div className="flex items-center justify-between gap-2 px-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-primary">
              Needs you
            </h2>
            {questions.length > 1 ? (
              <button
                type="button"
                disabled={asksBusy}
                onClick={() => {
                  if (!confirmDismissAll) {
                    setConfirmDismissAll(true);
                    return;
                  }
                  setConfirmDismissAll(false);
                  void dismissAllQuestions();
                }}
                onBlur={() => setConfirmDismissAll(false)}
                className={cn(
                  "-my-1 rounded-full px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50",
                  confirmDismissAll
                    ? "bg-destructive/10 text-destructive"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {confirmDismissAll ? `Dismiss all ${questions.length}?` : "Dismiss all"}
              </button>
            ) : null}
          </div>
          <div className="overflow-hidden rounded-2xl border border-primary/25 bg-primary/[0.03] shadow-sm">
            {/* Newest first, like the feed below it. The provider keeps the
                queue oldest-first for working through it in order; a feed
                that ran two directions at once just read as a bug. */}
            {[...questions]
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((q) => (
                <QuestionNotification key={q.id} q={q} />
              ))}
          </div>
        </section>
      ) : null}

      {posts !== null && posts.length === 0 && !questions.length ? (
        <div className="rounded-2xl border border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
          No notifications yet — verified results and future activity will collect here.
        </div>
      ) : null}

      {/* One compact row per notification, grouped by day. Leading dot for
          unread, avatar, agent · project · time, title, two-line body, and the
          media as a trailing thumbnail. No action buttons at rest: tapping the
          row opens the session, which is where following up actually belongs. */}
      {postGroups.map((group) => (
        <section key={group.label} className="space-y-1.5">
          <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-card/40 shadow-sm">
            {group.items.map((post) => {
              const live = !!post.sessionId && liveSessionIds.has(post.sessionId);
              const unread = notificationIsUnread(notificationReads, {
                id: shippedNotificationId(post),
                ts: post.ts,
              });
              const hasThumb = post.mediaItems.length > 0;
              return (
                <article key={post.id} className="relative border-b border-border/50 last:border-b-0">
                  {/* Tapping the post opens the conversation: straight into the
                      live session when it's still running, the same shared chat
                      renderer plus Resume when it has shipped and closed. */}
                  <button
                    type="button"
                    onClick={() => {
                      markPostRead(post);
                      if (!post.sessionId) return;
                      if (onReviewSession) onReviewSession(post);
                      else if (live) onOpenSession(post.sessionId);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2.5 py-2.5 pl-2.5 text-left transition-colors hover:bg-foreground/[0.02]",
                      hasThumb ? "pr-[4.75rem]" : "pr-3.5",
                    )}
                  >
                    {/* Fixed gutter whether or not the dot is there, so every
                        row's avatar lands on the same x. */}
                    <span
                      className={cn(
                        "mt-3 size-1.5 shrink-0 rounded-full",
                        unread && "bg-primary",
                      )}
                      title={unread ? "Unread" : undefined}
                    />
                    <span className="relative mt-0.5 shrink-0">
                      <img
                        src={agentIconSrc(post.agent)}
                        alt={agentIconAlt(post.agent)}
                        className="size-7 rounded-full border border-border bg-background p-1"
                      />
                      {live ? (
                        <span
                          title="Session is active"
                          className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-background"
                        />
                      ) : null}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
                        <span className="min-w-0 shrink truncate font-medium text-foreground/75">
                          {agentIconAlt(post.agent)}
                        </span>
                        {post.project ? (
                          <span className="min-w-0 shrink truncate">· {post.project}</span>
                        ) : null}
                        <span className="ml-auto shrink-0 tabular-nums">{timeAgo(post.ts)}</span>
                      </div>
                      {/* Two lines, not one: unlike a phone notification the
                          title here IS the content, and a narrow screen minus
                          the thumbnail clipped most of it. */}
                      <h3 className="mt-0.5 line-clamp-2 text-[13.5px] font-semibold leading-snug tracking-[-0.01em]">
                        {post.title}
                      </h3>
                      {post.summary ? (
                        // Plain text, two lines. Rendering markdown for a body
                        // that is clamped to two lines cost a whole markdown
                        // tree per row for text nobody can see.
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
                          {stripMd(post.summary)}
                        </p>
                      ) : null}
                    </div>
                  </button>
                  {hasThumb ? (
                    <div className="absolute right-3.5 top-2.5">
                      <ShipMediaThumb
                        items={post.mediaItems}
                        total={post.mediaTotal ?? post.mediaItems.length}
                        onExpand={openArtifact}
                      />
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>
      ))}
      {posts !== null && posts.length < postsTotal ? (
        <button
          type="button"
          onClick={() => void loadMorePosts()}
          disabled={postsBusy}
          className="w-full rounded-xl border border-border bg-card/40 px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:opacity-60"
        >
          {postsBusy ? "Loading…" : `Load more · ${postsTotal - posts.length} left`}
        </button>
      ) : null}
        </>
      )}
    </div>
  );
}
