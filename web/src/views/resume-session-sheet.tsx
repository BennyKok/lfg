import {
  ClaudeAccountBadge,
  CodingAgentsContext,
  SessionAgentIcon,
  useClaudeAccountNumber,
  useNumberedClaudeAccounts,
} from "../lib/session-ui";
import type { ClaudeAccountInfo, ResumableSession, Session } from "../App";
import { api } from "../lib/omg-client";
import {
  PROMPT_STASH_EVENT,
  clearPromptStash,
  readPromptStash,
  removePromptStash,
  type PromptStashEntry,
} from "../lib/prompt-stash";
import { timeAgo } from "../lib/session-ui";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { Archive, ChevronRight, Loader2, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";




/** The account number to stamp on a Claude mark, or null when there's nothing to tell apart. */

type ResumableResponse = {
  sessions: ResumableSession[];
  total: number;
  facets: ResumableFacets;
};

type ResumableFacets = {
  agents: Array<{ agent: string; count: number }>;
  projects: Array<{ project: string; count: number }>;
};

export default function ResumeSessionSheet({
  initial,
  scopedProject,
  onRestore,
  onPick,
  onClose,
}: {
  initial: ResumableSession[] | null;
  scopedProject: string;
  onRestore: (entry: PromptStashEntry) => void;
  onPick: (session: ResumableSession) => void;
  onClose: () => void;
}) {
  const PAGE = 25;
  const scoped = scopedProject && scopedProject !== "__all" ? scopedProject : "all";
  const initialStash = readPromptStash();
  const [view, setView] = useState<"stash" | "sessions">(() =>
    initialStash.some((entry) => entry.status !== "sent") ? "stash" : "sessions",
  );
  const [stash, setStash] = useState(initialStash);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [agent, setAgent] = useState("all");
  const [project, setProject] = useState(scoped);
  const [items, setItems] = useState<ResumableSession[]>(
    scoped === "all" && initial ? initial : [],
  );
  const [total, setTotal] = useState(scoped === "all" && initial ? initial.length : 0);
  const [facets, setFacets] = useState<ResumableFacets>({ agents: [], projects: [] });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  const requestRef = useRef(0);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    const refresh = () => setStash(readPromptStash());
    window.addEventListener(PROMPT_STASH_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(PROMPT_STASH_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(search.trim()), 220);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const fetchPage = useCallback(
    (reset: boolean) => {
      const token = reset ? ++requestRef.current : requestRef.current;
      const offset = reset ? 0 : itemsRef.current.length;
      if (reset) setLoading(true);
      else setLoadingMore(true);
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (debounced) params.set("search", debounced);
      if (agent !== "all") params.set("agent", agent);
      if (project !== "all") params.set("project", project);
      api<ResumableResponse>(`/api/sessions/resumable?${params.toString()}`)
        .then((response) => {
          if (token !== requestRef.current) return;
          const batch = Array.isArray(response.sessions) ? response.sessions : [];
          setItems((current) => (reset ? batch : [...current, ...batch]));
          setTotal(response.total ?? batch.length);
          setFacets(response.facets ?? { agents: [], projects: [] });
        })
        .catch(() => {
          if (token !== requestRef.current || !reset) return;
          setItems([]);
          setTotal(0);
          setFacets({ agents: [], projects: [] });
        })
        .finally(() => {
          if (token !== requestRef.current) return;
          if (reset) setLoading(false);
          else setLoadingMore(false);
        });
    },
    [agent, debounced, project],
  );

  useEffect(() => {
    if (view === "sessions") fetchPage(true);
  }, [fetchPage, view]);

  const stashQuery = search.trim().toLowerCase();
  const visibleStash = stash.filter((entry) =>
    !stashQuery
      ? true
      : `${entry.text} ${entry.sessionTitle ?? ""} ${entry.project ?? ""}`
          .toLowerCase()
          .includes(stashQuery),
  );
  const showSkeleton = loading && !items.length;
  const filtersActive = agent !== "all" || project !== "all" || !!debounced;
  const hasMore = items.length < total;
  const statusLabel = (status: PromptStashEntry["status"]) =>
    status === "draft"
      ? "Draft"
      : status === "sending"
        ? "Sending"
        : status === "failed"
          ? "Failed"
          : "Sent";

  return (
    <Drawer
      open
      repositionInputs={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DrawerContent className="mx-auto w-full max-w-2xl sm:max-w-2xl">
        <div className="flex max-h-[72dvh] min-h-0 flex-col overflow-hidden">
          <header className="shrink-0 border-b border-border/70 pb-2">
            <div className="flex h-9 items-center gap-2">
              <DrawerTitle className="text-[15px] font-semibold">Resume</DrawerTitle>
              <span className="text-xs text-muted-foreground">Stash & sessions</span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="ml-auto flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition hover:text-foreground active:scale-95"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <div className="inline-flex h-8 shrink-0 items-center rounded-full bg-muted p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setView("stash")}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full px-3 transition",
                    view === "stash"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                >
                  <Archive className="size-3.5" />
                  Stash
                  {stash.length ? <span className="tabular-nums opacity-60">{stash.length}</span> : null}
                </button>
                <button
                  type="button"
                  onClick={() => setView("sessions")}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full px-3 transition",
                    view === "sessions"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground",
                  )}
                >
                  <RotateCcw className="size-3.5" />
                  Sessions
                  {total ? <span className="tabular-nums opacity-60">{total}</span> : null}
                </button>
              </div>
              {view === "stash" && stash.length ? (
                <button
                  type="button"
                  onClick={() => clearPromptStash()}
                  className="ml-auto h-8 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-destructive"
                >
                  Clear
                </button>
              ) : null}
            </div>

            <div className="mt-2 flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={view === "stash" ? "Search prompts" : "Search sessions"}
                  aria-label={view === "stash" ? "Search stashed prompts" : "Search resumable sessions"}
                  autoComplete="off"
                  className="h-8 w-full rounded-full border border-border bg-muted/40 pl-8 pr-8 text-xs outline-none transition focus:border-ring focus:bg-background"
                />
                {search ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      searchRef.current?.focus();
                    }}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>

              {view === "sessions" ? (
                <>
                  <select
                    value={agent}
                    onChange={(event) => setAgent(event.target.value)}
                    aria-label="Filter by agent"
                    className="h-8 max-w-28 rounded-full border border-border bg-background px-2 text-xs outline-none"
                  >
                    <option value="all">All agents</option>
                    {facets.agents.map((item) => (
                      <option key={item.agent} value={item.agent}>
                        {item.agent} · {item.count}
                      </option>
                    ))}
                  </select>
                  {facets.projects.length || project !== "all" ? (
                    <select
                      value={project}
                      onChange={(event) => setProject(event.target.value)}
                      aria-label="Filter by project"
                      className="h-8 max-w-32 rounded-full border border-border bg-background px-2 text-xs outline-none"
                    >
                      <option value="all">All projects</option>
                      {project !== "all" &&
                      !facets.projects.some((item) => item.project === project) ? (
                        <option value={project}>{project}</option>
                      ) : null}
                      {facets.projects.map((item) => (
                        <option key={item.project} value={item.project}>
                          {item.project} · {item.count}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </>
              ) : null}
            </div>
          </header>

          <div className="min-h-0 max-h-[min(28rem,55dvh)] overflow-y-auto overscroll-contain pt-1">
            {view === "stash" ? (
              visibleStash.length ? (
                <div className="space-y-0.5">
                  {visibleStash.map((entry) => (
                    <div
                      key={entry.id}
                      className="group flex items-center gap-1 rounded-xl transition hover:bg-muted"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onRestore(entry);
                          onClose();
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-2 text-left active:scale-[0.99]"
                      >
                        <span
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-lg",
                            entry.status === "draft" || entry.status === "failed"
                              ? "bg-primary/12 text-primary"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          <Archive className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-sm leading-snug">{entry.text}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span
                              className={cn(
                                "font-medium",
                                entry.status === "failed" && "text-destructive",
                                entry.status === "draft" && "text-primary",
                              )}
                            >
                              {statusLabel(entry.status)}
                            </span>
                            <span>·</span>
                            <span className="truncate">
                              {entry.source === "new-session"
                                ? entry.project || "New session"
                                : entry.sessionTitle || "Session"}
                            </span>
                            <span>·</span>
                            <span className="shrink-0 tabular-nums">{timeAgo(entry.updatedAt)}</span>
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removePromptStash(entry.id)}
                        aria-label="Remove from Stash"
                        className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-60 transition hover:bg-background hover:text-destructive group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
                  <Archive className="size-5" />
                  <span>{stashQuery ? "No stashed prompts match" : "Typed and dictated prompts will appear here"}</span>
                </div>
              )
            ) : showSkeleton ? (
              <div className="animate-pulse space-y-1" aria-hidden>
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="flex items-center gap-2.5 px-2 py-2.5">
                    <div className="size-7 shrink-0 rounded-lg bg-muted" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="h-3 w-1/2 rounded bg-muted" />
                      <div className="h-2.5 w-3/4 rounded bg-muted/60" />
                    </div>
                  </div>
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
                <RotateCcw className="size-5" />
                <span>{filtersActive ? "No sessions match" : "No recent sessions to resume"}</span>
                {filtersActive ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setAgent("all");
                      setProject("all");
                    }}
                    className="rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground"
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <div className={cn("space-y-0.5 transition-opacity", loading && "opacity-60")}>
                  {items.map((session) => (
                    <button
                      key={session.sessionId}
                      type="button"
                      onClick={() => onPick(session)}
                      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-muted active:scale-[0.99]"
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
                        <SessionAgentIcon session={session} className="size-4" size="sm" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{session.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          {session.lastUserText ? (
                            <>
                              <span className="max-w-[60%] truncate">{session.lastUserText}</span>
                              <span>·</span>
                            </>
                          ) : null}
                          <span className="truncate">{session.project}</span>
                          <span>·</span>
                          <span className="shrink-0 tabular-nums">{timeAgo(session.lastActivityAt)}</span>
                        </span>
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                    </button>
                  ))}
                </div>
                {hasMore ? (
                  <button
                    type="button"
                    onClick={() => fetchPage(false)}
                    disabled={loadingMore}
                    className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium text-muted-foreground transition hover:bg-muted disabled:opacity-60"
                  >
                    {loadingMore ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" /> Loading…
                      </>
                    ) : (
                      `Load ${Math.min(PAGE, total - items.length)} more`
                    )}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// A compact iOS-style control pill: optional leading icon, a borderless native
// select, and a trailing chevron — no field label, the value speaks for itself.
