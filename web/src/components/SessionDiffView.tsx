// Session worktree diff surface. A small floating "diffs for review" bar sits
// near the bottom of the chat page whenever the focused session has changes,
// and opens a full diff viewer built on Pierre's diff library (@pierre/diffs,
// aka diffs.com) — Shiki-highlighted, split/unified, rendered fully client-side
// (nothing leaves the box). Data comes from GET /api/sessions/:id/diff* .

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Columns2, FileDiff, GitBranch, Loader2, Minus, Plus, Rows3, X } from "lucide-react";
import { cn } from "@/lib/utils";

// Pierre's diff renderer (@pierre/diffs, ~380 KB) is only needed once a user
// expands a file in the diff viewer — which most sessions never do. Load it
// lazily so it stays out of the first-paint bundle.
const PatchDiff = lazy(() =>
  import("@pierre/diffs/react").then((m) => ({ default: m.PatchDiff })),
);

type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};
type SessionDiff = {
  ok: boolean;
  isWorktree: boolean;
  branch: string | null;
  base: string | null;
  files: DiffFile[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean;
  fetchWarning?: string;
  error?: string;
};
type FilePatch = { path: string; patch: string; binary: boolean; truncated: boolean };
type DiffStat = { isWorktree: boolean; files: number; additions: number; deletions: number };
type DiffStyle = "unified" | "split";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || `${res.status}`);
  return data as T;
}

const STATUS_LABEL: Record<DiffFileStatus, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "new",
};
const STATUS_TONE: Record<DiffFileStatus, string> = {
  added: "text-[var(--success)]",
  untracked: "text-[var(--success)]",
  deleted: "text-[var(--destructive)]",
  renamed: "text-[var(--primary)]",
  modified: "text-muted-foreground",
};

// Follow the app's light/dark class so Shiki themes match the surrounding UI.
function useThemeType(): "light" | "dark" {
  const read = () => (typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [type, setType] = useState<"light" | "dark">(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setType(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return type;
}

const PIERRE_THEME = { dark: "github-dark", light: "github-light" } as const;

function StatCounts({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[11px] tabular-nums", className)}>
      <span className="text-[var(--success)]">+{additions}</span>
      <span className="text-[var(--destructive)]">−{deletions}</span>
    </span>
  );
}

// One file: a collapsible row (from the fast summary) that lazy-loads its raw
// patch on first expand and hands it to Pierre's <PatchDiff>.
const DiffFileCard = memo(function DiffFileCard({
  sid,
  file,
  diffStyle,
  themeType,
}: {
  sid: string;
  file: DiffFile;
  diffStyle: DiffStyle;
  themeType: "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<FilePatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(() => {
    setOpen((was) => {
      const next = !was;
      if (next && !patch && !loading && !file.binary) {
        setLoading(true);
        setError(null);
        getJson<{ file: FilePatch }>(`/api/sessions/${sid}/diff-file?path=${encodeURIComponent(file.path)}`)
          .then((d) => setPatch(d.file))
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setLoading(false));
      }
      return next;
    });
  }, [sid, file.path, file.binary, patch, loading]);

  const options = useMemo(
    () => ({
      diffStyle,
      theme: PIERRE_THEME,
      themeType,
      overflow: diffStyle === "unified" ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
    }),
    [diffStyle, themeType],
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
          {file.oldPath && file.oldPath !== file.path ? <span className="text-muted-foreground">{file.oldPath} → </span> : null}
          {file.path}
        </span>
        {loading ? <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" /> : null}
        <span className={cn("shrink-0 text-[10px] font-medium uppercase tracking-wide", STATUS_TONE[file.status])}>
          {STATUS_LABEL[file.status]}
        </span>
        <StatCounts additions={file.additions} deletions={file.deletions} className="shrink-0" />
      </button>
      {open ? (
        error ? (
          <div className="border-t border-border px-3 py-2 text-[12px] text-[var(--destructive)]">Could not load: {error}</div>
        ) : file.binary ? (
          <div className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">Binary file — not shown.</div>
        ) : loading || !patch ? (
          <div className="flex items-center gap-2 border-t border-border px-3 py-3 text-[12px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading diff…
          </div>
        ) : (
          <div className="overflow-x-auto border-t border-border text-[12px]">
            <Suspense
              fallback={
                <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Rendering diff…
                </div>
              }
            >
              <PatchDiff patch={patch.patch} options={options} disableWorkerPool />
            </Suspense>
            {patch.truncated ? (
              <div className="px-3 py-1.5 text-[11px] text-[var(--warning)]">Diff truncated (file too large).</div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
});

function SessionDiffViewer({ sid, onClose }: { sid: string; onClose: () => void }) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const themeType = useThemeType();

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    // Fast overview first — file list + counts, no patch bodies. Each file's
    // patch loads lazily on expand (DiffFileCard).
    getJson<{ diff: SessionDiff }>(`/api/sessions/${sid}/diff?summary=1`)
      .then((d) => alive && setDiff(d.diff))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = (
    <div className="fixed inset-0 z-[110] flex flex-col bg-background/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden bg-background md:my-6 md:h-[calc(100%-3rem)] md:rounded-2xl md:border md:border-border md:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <FileDiff className="size-4 text-[var(--primary)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">Changes for review</div>
            {diff?.branch ? (
              <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                <GitBranch className="size-3" />
                <span className="truncate font-mono">{diff.branch}</span>
                {diff.base ? <span className="opacity-70">· vs {diff.base}</span> : null}
              </div>
            ) : null}
          </div>
          {diff ? <StatCounts additions={diff.totals.additions} deletions={diff.totals.deletions} /> : null}
          {/* unified / split layout toggle */}
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setDiffStyle("unified")}
              aria-label="Unified view"
              className={cn("rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground", diffStyle === "unified" && "bg-muted text-foreground")}
            >
              <Rows3 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setDiffStyle("split")}
              aria-label="Split view"
              className={cn("rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground", diffStyle === "split" && "bg-muted text-foreground")}
            >
              <Columns2 className="size-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diff"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {error ? (
            <div className="rounded-lg border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-[13px] text-[var(--destructive)]">
              Could not load diff: {error}
            </div>
          ) : !diff ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Computing diff…
            </div>
          ) : diff.files.length === 0 ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">No changes on this branch.</div>
          ) : (
            <>
              {diff.fetchWarning ? (
                <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-1.5 text-[12px] text-[var(--warning)]">
                  {diff.fetchWarning}
                </div>
              ) : null}
              {diff.files.map((f) => (
                <DiffFileCard key={f.path} sid={sid} file={f} diffStyle={diffStyle} themeType={themeType} />
              ))}
              {diff.truncated ? (
                <div className="px-1 py-1 text-[12px] text-[var(--warning)]">Some changes were omitted — the diff is very large.</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

// The floating bar. Polls diff-stat while mounted; renders nothing unless the
// session's worktree actually has changes.
export const SessionDiffBar = memo(function SessionDiffBar({
  sid,
  onVisibilityChange,
}: {
  sid: string | null;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    if (!sid) return;
    getJson<{ stat: DiffStat }>(`/api/sessions/${sid}/diff-stat`)
      .then((d) => setStat(d.stat))
      .catch(() => {});
  }, [sid]);

  useEffect(() => {
    setStat(null);
    setOpen(false);
    if (!sid) return;
    refresh();
    timer.current = setInterval(() => {
      if (!document.hidden) refresh();
    }, 8000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [sid, refresh]);

  const hasDiffs = !!sid && !!stat?.isWorktree && stat.files > 0;
  const label = useMemo(() => (stat ? `${stat.files} file${stat.files === 1 ? "" : "s"}` : ""), [stat]);

  // Let the parent reserve bottom scroll padding only while the bar is shown,
  // so the pill never overlaps the last message.
  useEffect(() => {
    onVisibilityChange?.(hasDiffs);
  }, [hasDiffs, onVisibilityChange]);
  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange]);

  if (!sid) return null;

  return (
    <>
      {hasDiffs ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="lfg-scroll-pill pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/95 px-3.5 py-1.5 text-xs font-medium text-foreground shadow-md backdrop-blur transition-colors hover:bg-card"
          >
            <FileDiff className="size-3.5 text-[var(--primary)]" />
            <span>{label} changed</span>
            <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums">
              <span className="flex items-center text-[var(--success)]">
                <Plus className="size-3" />
                {stat!.additions}
              </span>
              <span className="flex items-center text-[var(--destructive)]">
                <Minus className="size-3" />
                {stat!.deletions}
              </span>
            </span>
            <span className="text-[11px] text-muted-foreground">Review</span>
          </button>
        </div>
      ) : null}
      {open ? <SessionDiffViewer sid={sid} onClose={() => setOpen(false)} /> : null}
    </>
  );
});
