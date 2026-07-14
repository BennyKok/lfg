import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Globe,
  Loader2,
  LogIn,
  Monitor,
  Plus,
  RefreshCw,
  TestTube2,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import BrowserLoginView from "./BrowserLoginView";
import { useAppDialog } from "@/components/ui/app-dialog";

// Manage saved cloud-browser login profiles. Each profile captures the cookies
// /storage state for a set of origins so an agent can act as the logged-in user
// without re-authenticating every time. Re-auth / new login open a live remote
// browser (BrowserLoginView) over a WebSocket-backed session.

type ProfileMeta = {
  id: string;
  name: string;
  origins: string[];
  createdAt: number;
  lastUsedAt: number | null;
  status: "active" | "expired";
};

type TestResult = {
  loggedIn: boolean;
  title: string;
  finalUrl: string;
};

// Mirror of App.tsx's tiny fetch wrapper: relative paths, JSON in/out, throws on
// non-2xx with the server's `error` field when present.
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

// How the live login browser should be sized. "fit" matches the user's own
// screen so pages lay out the way they're used to; the presets force a classic
// desktop or phone viewport for testing responsive logins.
type ViewportMode = "fit" | "desktop" | "mobile";

type Viewport = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
};

const VIEWPORT_LABELS: Record<ViewportMode, string> = {
  fit: "Fit my screen",
  desktop: "Desktop",
  mobile: "Mobile",
};

function computeViewport(mode: ViewportMode): Viewport {
  if (mode === "mobile") {
    return { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true };
  }
  if (mode === "desktop") {
    return { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false };
  }
  // "fit": match the visible browser area on this device.
  return {
    width: Math.round(window.innerWidth) || 1280,
    height: Math.round(window.innerHeight) || 800,
    deviceScaleFactor: 1,
    isMobile: false,
  };
}

const VIEWPORT_KEY = "lfg_browser_viewport_mode";

function timeAgo(value?: number | null): string {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// The active live-browser session, if any. Tracks why it was opened so we can
// refresh + clear test state on save.
type LiveSession = { sessionId: string; profileId: string | null };

export default function BrowserProfiles() {
  const appDialog = useAppDialog();
  const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [live, setLive] = useState<LiveSession | null>(null);
  const [viewportMode, setViewportMode] = useState<ViewportMode>(() => {
    const saved = localStorage.getItem(VIEWPORT_KEY);
    return saved === "desktop" || saved === "mobile" || saved === "fit"
      ? saved
      : "fit";
  });

  useEffect(() => {
    localStorage.setItem(VIEWPORT_KEY, viewportMode);
  }, [viewportMode]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api<ProfileMeta[]>("/api/browser/profiles");
      setProfiles(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load profiles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleNewLogin = useCallback(async () => {
    const raw = await appDialog.prompt({
      title: "New browser login",
      description: "Enter the site you want to log in to.",
      defaultValue: "https://",
      inputLabel: "Website URL",
      confirmLabel: "Open login",
    });
    if (raw == null) return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === "https://") return;
    const url = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const { sessionId } = await api<{ sessionId: string }>("/api/browser/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, viewport: computeViewport(viewportMode) }),
      });
      setLive({ sessionId, profileId: null });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start session");
    }
  }, [appDialog, viewportMode]);

  const handleReauth = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const { sessionId } = await api<{ sessionId: string }>(
          `/api/browser/profiles/${encodeURIComponent(id)}/reauth`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ viewport: computeViewport(viewportMode) }),
          },
        );
        setLive({ sessionId, profileId: id });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to start re-auth");
      } finally {
        setBusyId(null);
      }
    },
    [viewportMode],
  );

  const handleTest = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      const result = await api<TestResult>(
        `/api/browser/profiles/${encodeURIComponent(id)}/test`,
        { method: "POST" },
      );
      setTests((cur) => ({ ...cur, [id]: result }));
      if (result.loggedIn) {
        toast.success(`Logged in${result.title ? ` — ${result.title}` : ""}`);
      } else {
        toast.error("Not logged in");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleDelete = useCallback(async (p: ProfileMeta) => {
    const confirmed = await appDialog.confirm({
      title: `Delete profile “${p.name}”?`,
      description: "This saved login will be permanently removed. This cannot be undone.",
      confirmLabel: "Delete profile",
      destructive: true,
    });
    if (!confirmed) return;
    setBusyId(p.id);
    try {
      await api(`/api/browser/profiles/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      setProfiles((cur) => cur.filter((x) => x.id !== p.id));
      setTests((cur) => {
        const next = { ...cur };
        delete next[p.id];
        return next;
      });
      toast.success("Profile deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }, [appDialog]);

  const closeLive = useCallback(() => setLive(null), []);

  const onSaved = useCallback(
    (_profileId: string) => {
      void refresh();
    },
    [refresh],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-4 py-3">
        <Globe className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">Browser profiles</div>
          <div className="truncate text-xs text-muted-foreground">
            Saved logins agents can reuse to act as you
          </div>
        </div>
        {/* Controls drop to their own full-width row on phones so the long
            viewport label + buttons never overflow the title row. */}
        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <label className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Monitor className="size-3.5 shrink-0" />
            <select
              value={viewportMode}
              onChange={(e) => setViewportMode(e.target.value as ViewportMode)}
              aria-label="Login browser size"
              title="Size of the live login browser"
              className="min-w-0 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground outline-none focus:border-primary"
            >
              {(Object.keys(VIEWPORT_LABELS) as ViewportMode[]).map((m) => (
                <option key={m} value={m}>
                  {VIEWPORT_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={loading}
            className="shrink-0"
          >
            <RefreshCw className={"size-4" + (loading ? " animate-spin" : "")} />
          </Button>
          <Button
            size="sm"
            variant="brand"
            onClick={() => void handleNewLogin()}
            className="shrink-0"
          >
            <Plus className="size-4" />
            <span className="ml-1">New login</span>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading && profiles.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading profiles…
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <Globe className="size-8 opacity-40" />
            <div>No saved profiles yet.</div>
            <Button size="sm" variant="brand" onClick={() => void handleNewLogin()}>
              <Plus className="size-4" />
              <span className="ml-1">New login</span>
            </Button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {profiles.map((p) => {
              const test = tests[p.id];
              const busy = busyId === p.id;
              return (
                <li
                  key={p.id}
                  className="rounded-xl border border-border bg-card px-3.5 py-3 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-sm font-semibold">{p.name}</span>
                        <Badge
                          variant={p.status === "active" ? "default" : "destructive"}
                          className="shrink-0"
                        >
                          {p.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {p.origins.length ? p.origins.join(", ") : "no origins"}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground/80">
                        Last used {timeAgo(p.lastUsedAt)}
                      </div>
                      {test ? (
                        <div
                          className={
                            "mt-1.5 flex items-center gap-1.5 text-xs " +
                            (test.loggedIn ? "text-emerald-600" : "text-destructive")
                          }
                        >
                          {test.loggedIn ? (
                            <CheckCircle2 className="size-3.5" />
                          ) : (
                            <XCircle className="size-3.5" />
                          )}
                          <span className="min-w-0 truncate">
                            {test.loggedIn ? "Logged in" : "Not logged in"}
                            {test.title ? ` — ${test.title}` : ""}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleReauth(p.id)}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <LogIn className="size-4" />
                      )}
                      <span className="ml-1">Re-auth</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleTest(p.id)}
                      disabled={busy}
                    >
                      <TestTube2 className="size-4" />
                      <span className="ml-1">Test</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleDelete(p)}
                      disabled={busy}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                      <span className="ml-1">Delete</span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Live remote-browser overlay */}
      {live ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-6">
          <div className="flex h-full max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
            <BrowserLoginView
              sessionId={live.sessionId}
              onClose={closeLive}
              onSaved={onSaved}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
