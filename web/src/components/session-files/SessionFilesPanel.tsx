// The Files panel: browse the session's checkout, read any file, and send an
// edit to the agent as a patch.
//
// Lazy loading is staged so the first paint pays nothing and each step pays only
// for itself:
//   1. panel shell (this module)      — opened from the chat bar
//   2. @pierre/trees                  — on open, for the tree
//   3. @pierre/diffs <File>           — on opening a file
//   4. @pierre/diffs/edit             — on pressing Edit
//
// There is no write endpoint. "Send to agent" turns the edit into a unified diff
// and posts it to the session's message queue, so the agent applies it with its
// own tools and stays the single writer of its worktree.

import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpFromLine,
  Check,
  ChevronRight,
  FileCode,
  Loader2,
  Pencil,
  Send,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { omgFetch } from "@/lib/omg-client";
import { lazyWithReload } from "@/lib/lazy-with-reload";
import { buildFilePatch } from "@/lib/session-file-patch";
import type { SessionFile, SessionTree, ThemeType } from "./types";

const FileTreePane = lazyWithReload("session-file-tree", () => import("./FileTreePane"));
const FileViewer = lazyWithReload("session-file-viewer", () => import("./FileViewer"));
const FileEditor = lazyWithReload("session-file-editor", () => import("./FileEditor"));

async function getJson<T>(path: string): Promise<T> {
  const res = await omgFetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error || `${res.status}`);
  return data as T;
}

function useThemeType(): ThemeType {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light";
  const [type, setType] = useState<ThemeType>(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setType(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return type;
}

const Spinner = ({ label }: { label: string }) => (
  <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted-foreground">
    <Loader2 className="size-3.5 animate-spin" /> {label}
  </div>
);

// Clickable path segments from the ceiling down to the current root. Anything
// above the ceiling is rendered as inert text, because the server would refuse
// it anyway.
function Breadcrumb({ tree, onNavigate }: { tree: SessionTree; onNavigate: (root: string) => void }) {
  const crumbs = useMemo(() => {
    const segments = tree.root.split("/").filter(Boolean);
    return segments.map((name, i) => {
      const abs = "/" + segments.slice(0, i + 1).join("/");
      return { name, abs, browsable: abs === tree.ceiling || abs.startsWith(tree.ceiling + "/") };
    });
  }, [tree.root, tree.ceiling]);

  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[11px] text-muted-foreground">
      {crumbs.map((crumb, i) => (
        <span key={crumb.abs} className="flex items-center gap-0.5">
          {i > 0 ? <ChevronRight className="size-3 opacity-50" /> : null}
          {crumb.browsable && crumb.abs !== tree.root ? (
            <button
              type="button"
              onClick={() => onNavigate(crumb.abs)}
              className="rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
            >
              {crumb.name}
            </button>
          ) : (
            <span className={cn("px-1 py-0.5", crumb.abs === tree.root && "font-semibold text-foreground")}>
              {crumb.name}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

function SessionFilesViewer({ sid, onClose }: { sid: string; onClose: () => void }) {
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<SessionTree | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<SessionFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const themeType = useThemeType();

  // The editor reports every keystroke; keep it in a ref so typing does not
  // re-render the whole panel (and remount the tree) on each character.
  const draftRef = useRef<string | null>(null);
  const onDraftChange = useCallback((contents: string) => {
    draftRef.current = contents;
  }, []);

  // Mirrors `selected` for the open-guard below, which must read the current
  // value without making openFile depend on it (that would change its identity
  // on every selection and retrigger the tree's notify effect).
  const selectedRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    setTree(null);
    setTreeError(null);
    const query = root ? `?root=${encodeURIComponent(root)}` : "";
    getJson<{ tree: SessionTree }>(`/api/sessions/${sid}/tree${query}`)
      .then((d) => alive && setTree(d.tree))
      .catch((e) => alive && setTreeError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sid, root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const openFile = useCallback(
    (relPath: string) => {
      if (!tree) return;
      // Re-opening the file that is already open would refetch it and drop an
      // in-progress edit. Selecting the current row again is a no-op.
      if (relPath === selectedRef.current) return;
      selectedRef.current = relPath;
      setSelected(relPath);
      setEditing(false);
      setSend({ kind: "idle" });
      setNote("");
      draftRef.current = null;
      setFile(null);
      setFileError(null);
      setFileLoading(true);
      getJson<{ file: SessionFile }>(
        `/api/sessions/${sid}/file?path=${encodeURIComponent(`${tree.root}/${relPath}`)}`,
      )
        .then((d) => {
          setFile(d.file);
          draftRef.current = d.file.contents;
        })
        .catch((e) => setFileError(e instanceof Error ? e.message : String(e)))
        .finally(() => setFileLoading(false));
    },
    [sid, tree],
  );

  const navigate = useCallback((next: string) => {
    setRoot(next);
    selectedRef.current = null;
    setSelected(null);
    setFile(null);
    setEditing(false);
  }, []);

  // Seed the editor from the draft so leaving and re-entering edit mode does not
  // silently drop unsent work. Recomputed only when the file changes or edit
  // mode is entered — a fresh object on every render would remount the editor
  // and reset the document mid-keystroke.
  const editorFile = useMemo(
    () => (file ? { ...file, contents: draftRef.current ?? file.contents } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `editing` is the
    // intended trigger; draftRef is a ref and deliberately not reactive.
    [file, editing],
  );

  const sendToAgent = useCallback(async () => {
    if (!file || draftRef.current === null) return;
    const displayPath = selected ?? file.name;
    const patch = buildFilePatch({
      displayPath,
      original: file.contents,
      edited: draftRef.current,
      note,
    });
    if (!patch.ok) {
      setSend({
        kind: "error",
        message:
          patch.reason === "unchanged"
            ? "No changes to send."
            : "That edit is too large to send as a patch — split it into smaller changes.",
      });
      return;
    }

    setSend({ kind: "sending" });
    try {
      const res = await omgFetch(`/api/sessions/${sid}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Queued rather than steered: the agent finishes its current turn and
        // then picks the edit up, instead of having its thought interrupted.
        body: JSON.stringify({ text: patch.message, mode: "queue" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // 409 is the dead-session case: nobody is running to apply the patch.
        setSend({
          kind: "error",
          message:
            res.status === 409
              ? "This session isn't running, so there's no agent to apply the edit. Resume it and try again."
              : data.error || `Couldn't send (${res.status})`,
        });
        return;
      }
      setSend({ kind: "sent" });
      setEditing(false);
    } catch (e) {
      setSend({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [sid, file, selected, note]);

  const body = (
    <div className="fixed inset-0 z-[110] flex flex-col bg-background/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden bg-background md:my-6 md:h-[calc(100%-3rem)] md:rounded-2xl md:border md:border-border md:shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <FileCode className="size-4 shrink-0 text-[var(--primary)]" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-foreground">Files</div>
            {tree ? <Breadcrumb tree={tree} onNavigate={navigate} /> : null}
          </div>
          {tree?.parent ? (
            <button
              type="button"
              onClick={() => navigate(tree.parent!)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowUpFromLine className="size-3" /> Up
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close files"
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="h-52 shrink-0 overflow-hidden border-b border-border md:h-auto md:w-72 md:border-b-0 md:border-r">
            {treeError ? (
              <div className="px-3 py-2 text-[12px] text-[var(--destructive)]">Could not list files: {treeError}</div>
            ) : !tree ? (
              <Spinner label="Listing files…" />
            ) : (
              <Suspense fallback={<Spinner label="Loading tree…" />}>
                <FileTreePane
                  paths={tree.paths}
                  gitStatus={tree.gitStatus}
                  selectedPath={selected}
                  onSelectFile={openFile}
                />
              </Suspense>
            )}
          </aside>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {tree?.truncated ? (
              <div className="border-b border-border bg-[var(--warning)]/10 px-3 py-1.5 text-[11px] text-[var(--warning)]">
                This directory is very large — the listing was truncated.
              </div>
            ) : null}

            {!selected ? (
              <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
                Select a file to read it. Changed files carry a git badge.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">{selected}</span>
                  {file && !file.binary ? (
                    <button
                      type="button"
                      onClick={() => {
                        // Toggling back to read view keeps the draft — the edit
                        // is only discarded by opening a different file.
                        setEditing((was) => !was);
                        setSend({ kind: "idle" });
                      }}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors",
                        editing
                          ? "border-[var(--primary)]/40 bg-[var(--primary)]/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <Pencil className="size-3" /> {editing ? "Editing" : "Edit"}
                    </button>
                  ) : null}
                </div>

                <div className="min-h-0 flex-1 overflow-auto text-[12px]">
                  {fileError ? (
                    <div className="px-3 py-2 text-[12px] text-[var(--destructive)]">Could not open: {fileError}</div>
                  ) : fileLoading || !file ? (
                    <Spinner label="Opening…" />
                  ) : file.binary ? (
                    <div className="px-3 py-3 text-[12px] text-muted-foreground">Binary file — not shown.</div>
                  ) : (
                    <Suspense fallback={<Spinner label={editing ? "Loading editor…" : "Rendering…"} />}>
                      {editing ? (
                        <FileEditor file={editorFile ?? file} themeType={themeType} onChange={onDraftChange} />
                      ) : (
                        <FileViewer file={file} themeType={themeType} />
                      )}
                    </Suspense>
                  )}
                  {file?.truncated ? (
                    <div className="px-3 py-1.5 text-[11px] text-[var(--warning)]">
                      File truncated — only the first megabyte is shown.
                    </div>
                  ) : null}
                </div>

                {editing ? (
                  <div className="space-y-2 border-t border-border p-3">
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      placeholder="Optional: anything else the agent should do alongside this edit"
                      className="w-full resize-none rounded-lg border border-border bg-card px-2.5 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-[var(--primary)]/50"
                    />
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                        Your edit is sent to the agent as a patch — it applies the change, so nothing here writes to
                        disk behind its back.
                      </p>
                      <button
                        type="button"
                        onClick={sendToAgent}
                        disabled={send.kind === "sending"}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-60"
                      >
                        {send.kind === "sending" ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Send className="size-3.5" />
                        )}
                        Send to agent
                      </button>
                    </div>
                  </div>
                ) : null}

                {send.kind === "sent" ? (
                  <div className="flex items-center gap-2 border-t border-[var(--success)]/40 bg-[var(--success)]/10 px-3 py-2 text-[12px] text-foreground">
                    <Check className="size-3.5 text-[var(--success)]" /> Patch queued — the agent will apply it on its
                    next turn.
                  </div>
                ) : null}
                {send.kind === "error" ? (
                  <div className="border-t border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2 text-[12px] text-[var(--destructive)]">
                    {send.message}
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
}

// Default export so the chat bar can lazy-import the whole panel — including
// jsdiff and the two Pierre chunks it pulls in — only once Files is opened.
export default memo(SessionFilesViewer);
