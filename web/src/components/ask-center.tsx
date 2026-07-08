// AskCenter — the human-in-the-loop reply surface. Polls /api/ask for open
// questions raised by headless agents (the supervisor) and lets the user answer
// by tapping a suggested option or typing. Answers POST back to
// /api/ask/<id>/answer, which wakes the agent's blocked long-poll.
//
// Three surfaces share one poll loop via <AskProvider>:
//   • <AskNavButton/>  — a top-right island button with an unanswered badge;
//                        the persistent home for the feature. Opens the page,
//                        and is where a collapsed queue re-surfaces from.
//   • <AskCenter/>     — a compact floating card for the next question. Can be
//                        collapsed (tucked away to the nav badge) or expanded
//                        to the full page.
//   • <AskPage/>       — a full app page (its own tab) listing every open
//                        question, each answerable inline. Front and centre for
//                        working the whole queue.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Maximize2,
  MessageCircleQuestion,
  Send,
} from "lucide-react";

type Question = {
  id: string;
  question: string;
  options?: string[];
  agentId?: string | null;
  sessionId?: string | null;
  createdAt: number;
};

const POLL_MS = 5000;

// Flatten markdown to a one-line plain-text preview (toasts, the compact
// floating card). Questions written by agents often arrive full of headings
// and lists; previews should read as a sentence, not render as a document.
function stripMd(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s*[-*+]\s+/gm, "") // list bullets
    .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_/g, "$1$2$3$4")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function timeAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Question body renderer. Short one-liners get comfortable large type; anything
// longer renders as compact markdown with headings demoted to body-weight
// labels — a question card must never look like a document of h1s.
function QuestionBody({ text, compact }: { text: string; compact?: boolean }) {
  const short = text.length <= 140 && !/\n/.test(text) && !/^#{1,6}\s/m.test(text);
  if (short) {
    return (
      <div
        className={cn(
          "font-medium leading-snug tracking-[-0.01em]",
          compact ? "text-sm" : "text-lg",
        )}
      >
        {text}
      </div>
    );
  }
  return (
    <MessageResponse
      className={cn(
        "text-sm leading-relaxed",
        // Demote all heading levels: same size as body, just bolder. Kills the
        // "gigantic pile of title tags" failure mode without losing structure.
        "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-sm",
        "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
        "[&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1",
        "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5",
      )}
    >
      {text}
    </MessageResponse>
  );
}

type AskContextValue = {
  questions: Question[];
  busy: boolean;
  answer: (q: Question, text: string) => Promise<void>;
  /** Tuck the floating card away "for later" without answering. */
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
};

const AskContext = createContext<AskContextValue | null>(null);

function useAsk(): AskContextValue {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk must be used within <AskProvider>");
  return ctx;
}

// Read-only count of open questions — for nav badges etc.
export function useAskCount(): number {
  return useAsk().questions.length;
}

// Owns the single poll loop + queue + shared UI state so the nav button, the
// floating card, and the page all read one source of truth.
export function AskProvider({ children }: { children: React.ReactNode }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const seen = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      // Prefer this device's filtered feed (scoped to the push-bound user) so we
      // never surface another user's question. Falls back to the open list when
      // notifications aren't enabled on this device.
      let feedUrl = "/api/ask?status=open";
      try {
        if ("serviceWorker" in navigator && "PushManager" in window) {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub?.endpoint)
            feedUrl = `/api/push/pending?endpoint=${encodeURIComponent(sub.endpoint)}`;
        }
      } catch {
        // no subscription — keep the unscoped fallback
      }
      const res = await fetch(feedUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { questions: Question[] };
      const qs = data.questions || [];
      // Oldest-first so we work the queue in order.
      qs.sort((a, b) => a.createdAt - b.createdAt);
      setQuestions(qs);
      let fresh = false;
      for (const q of qs) {
        if (!seen.current.has(q.id)) {
          seen.current.add(q.id);
          fresh = true;
          toast("An agent needs your input", {
            description: stripMd(q.question).slice(0, 140),
          });
        }
      }
      // A genuinely new question overrides a "collapse for later" — surface it.
      if (fresh) setCollapsed(false);
    } catch {
      // transient — next tick retries
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [refresh]);

  const answer = useCallback(
    async (q: Question, text: string) => {
      if (busy || !text.trim()) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/ask/${q.id}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: text.trim(), via: "web" }),
        });
        if (!res.ok) throw new Error(await res.text());
        // Drop it locally so the next question shows immediately; the poll
        // reconciles shortly after.
        setQuestions((prev) => prev.filter((x) => x.id !== q.id));
        toast("Sent to the agent");
      } catch {
        toast.error("Could not send your answer");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  return (
    <AskContext.Provider
      value={{ questions, busy, answer, collapsed, setCollapsed }}
    >
      {children}
    </AskContext.Provider>
  );
}

// Top-right island button — the persistent entry point. Shows an unanswered
// count badge and a gentle pulse when agents are waiting; muted when the queue
// is empty. Tapping opens the page (and un-collapses).
export function AskNavButton({
  active,
  onOpen,
}: {
  active?: boolean;
  onOpen: () => void;
}) {
  const { questions, setCollapsed } = useAsk();
  const count = questions.length;
  const waiting = count > 0;
  // No question in flight: don't show the button in the right top island
  // (stay visible while the Ask tab is open so the user can navigate back out).
  if (!waiting && !active) return null;
  return (
    <button
      type="button"
      onClick={() => {
        setCollapsed(false);
        onOpen();
      }}
      aria-current={active ? "page" : undefined}
      aria-label={
        waiting
          ? `${count} question${count === 1 ? "" : "s"} for you`
          : "Questions"
      }
      title={waiting ? `${count} waiting for you` : "Questions"}
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ease-out active:scale-[0.96]",
        active
          ? "bg-primary/12 text-primary"
          : waiting
            ? "bg-primary/12 text-primary"
            : "text-muted-foreground hover:text-foreground",
      )}
    >
      {waiting && !active ? (
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
      ) : null}
      <MessageCircleQuestion className="relative size-[18px]" />
      {waiting ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
}

// Compact floating card for the next question. Hidden when collapsed.
export function AskCenter({ onExpand }: { onExpand: () => void }) {
  const { questions, busy, answer, setCollapsed, collapsed } = useAsk();
  const [draft, setDraft] = useState("");
  const current = questions[0] ?? null;

  // Reset the draft whenever the active question changes.
  useEffect(() => {
    setDraft("");
  }, [current?.id]);

  if (!current || collapsed) return null;

  const queued = questions.length - 1;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-[var(--lfg-orb-stack-bottom)]">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-primary/30 bg-background p-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.28)]">
        <div className="mb-2 flex items-start gap-2">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <MessageCircleQuestion className="size-3.5" />
          </div>
          <button
            type="button"
            onClick={onExpand}
            className="min-w-0 flex-1 text-left"
          >
            <div className="text-[11px] font-medium text-muted-foreground">
              Agent needs your input{queued > 0 ? ` · ${queued} more` : ""}
            </div>
            <div className="mt-0.5 line-clamp-3 text-sm font-medium leading-snug">
              {stripMd(current.question)}
            </div>
          </button>
          <div className="-mr-1 -mt-1 flex shrink-0 items-center">
            <button
              type="button"
              onClick={onExpand}
              aria-label="Open all questions"
              title="Open all questions"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Maximize2 className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse for later"
              title="Collapse for later"
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
        </div>

        {current.options?.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {current.options.map((o) => (
              <Button
                key={o}
                variant="tint"
                size="sm"
                disabled={busy}
                onClick={() => void answer(current, o)}
              >
                {o}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type a reply…"
            rows={1}
            className="max-h-28 min-h-9 flex-1 resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void answer(current, draft);
              }
            }}
          />
          <Button
            size="icon-sm"
            disabled={busy || !draft.trim()}
            onClick={() => void answer(current, draft)}
            aria-label="Send answer"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// Full app page (its own tab) — a Tinder-style deck of open questions. The top
// card is answerable inline; swipe (or arrow) to move through the stack.
export function AskPage() {
  const { questions } = useAsk();
  const count = questions.length;
  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <MessageCircleQuestion className="size-6" />
        </div>
        <div>
          <h1 className="font-heading text-lg font-medium tracking-[-0.01em]">
            Questions for you
          </h1>
          <p className="text-sm text-muted-foreground">
            {count > 0
              ? `${count} agent${count === 1 ? "" : "s"} waiting on your input`
              : "You're all caught up"}
          </p>
        </div>
      </div>

      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Inbox className="size-7" />
          </div>
          <div className="text-sm font-medium">No questions right now</div>
          <div className="max-w-xs text-xs text-muted-foreground">
            When an agent needs a decision, it'll show up here and you'll get a
            notification.
          </div>
        </div>
      ) : (
        <SwipeStack questions={questions} />
      )}
    </div>
  );
}

const SWIPE_THRESHOLD = 90; // px of horizontal drag that commits a navigation
const FLY_MS = 200; // off-screen / settle animation duration

// The card deck. Holds the active index and the live drag offset; renders the
// top card (draggable, interactive) plus up to two scaled "peek" cards behind.
function SwipeStack({ questions }: { questions: Question[] }) {
  const { answer } = useAsk();
  const [pos, setPos] = useState(0);
  const [dx, setDx] = useState(0);
  const [releasing, setReleasing] = useState<
    null | "next" | "prev" | "back" | "answered"
  >(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const len = questions.length;
  // Keep pos valid as questions get answered/added underneath us.
  useEffect(() => {
    if (pos > len - 1) setPos(Math.max(0, len - 1));
  }, [len, pos]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const cur = Math.min(pos, len - 1);
  const hasNext = cur < len - 1;
  const hasPrev = cur > 0;

  const go = useCallback(
    (dir: "next" | "prev") => {
      if ((dir === "next" && !hasNext) || (dir === "prev" && !hasPrev)) {
        // Nothing there — rubber-band back to centre.
        setReleasing("back");
        setDx(0);
        timer.current = setTimeout(() => setReleasing(null), FLY_MS);
        return;
      }
      setReleasing(dir);
      timer.current = setTimeout(() => {
        setPos((p) =>
          Math.max(0, Math.min(len - 1, dir === "next" ? p + 1 : p - 1)),
        );
        setDx(0);
        setReleasing(null);
      }, FLY_MS);
    },
    [hasNext, hasPrev, len],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    if (releasing) return;
    dragging.current = true;
    startX.current = e.clientX;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    setDx(e.clientX - startX.current);
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (dx <= -SWIPE_THRESHOLD) go("next");
    else if (dx >= SWIPE_THRESHOLD) go("prev");
    else {
      setReleasing("back");
      setDx(0);
      timer.current = setTimeout(() => setReleasing(null), FLY_MS);
    }
  };

  // Answer the top card with a fly-up, then hand off to the queue (which drops
  // it and floats the next card forward).
  const handleAnswer = useCallback(
    (text: string) => {
      if (!text.trim() || releasing) return;
      const q = questions[cur];
      setReleasing("answered");
      timer.current = setTimeout(() => {
        void answer(q, text);
        setDx(0);
        setReleasing(null);
      }, FLY_MS);
    },
    [answer, cur, questions, releasing],
  );

  // Top-card transform: follow the finger while dragging, fly off on commit,
  // up-and-out when answered, spring back otherwise.
  let topTransform: string;
  let topOpacity = 1;
  if (releasing === "next") topTransform = "translateX(-130%) rotate(-12deg)";
  else if (releasing === "prev") topTransform = "translateX(130%) rotate(12deg)";
  else if (releasing === "answered") {
    topTransform = "translateY(-130%) scale(0.92)";
    topOpacity = 0;
  } else {
    const rot = Math.max(-12, Math.min(12, dx * 0.05));
    topTransform = `translateX(${dx}px) rotate(${rot}deg)`;
  }
  const topStyle: React.CSSProperties = {
    transform: topTransform,
    opacity: topOpacity,
    transition: dragging.current
      ? "none"
      : `transform ${FLY_MS}ms ease-out, opacity ${FLY_MS}ms ease-out`,
    touchAction: "pan-y",
  };

  // As you drag, the next peek card eases forward.
  const progress = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);
  const peeks = [questions[cur + 1], questions[cur + 2]].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-1">
        {/* Peek cards behind, furthest first so the nearest paints on top. */}
        {peeks
          .map((q, depth) => ({ q, depth }))
          .reverse()
          .map(({ q, depth }) => {
            const base = (depth + 1) * 0.05;
            const scale = 1 - base + (depth === 0 ? base * progress : 0);
            const translateY = (depth + 1) * 14 - (depth === 0 ? 14 * progress : 0);
            return (
              <div
                key={q.id}
                className="absolute inset-0"
                style={{
                  transform: `translateY(${translateY}px) scale(${scale})`,
                  opacity: depth === 0 ? 0.7 + 0.3 * progress : 0.5,
                  transition: dragging.current ? "none" : "transform 200ms ease-out, opacity 200ms ease-out",
                }}
              >
                <QuestionCard q={q} index={cur + 1 + depth} interactive={false} />
              </div>
            );
          })}

        {/* Active card. */}
        <div
          key={questions[cur].id}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={topStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <QuestionCard
            q={questions[cur]}
            index={cur}
            interactive
            onAnswer={handleAnswer}
          />
          {/* Swipe-direction hints, fading in with drag distance. */}
          {hasPrev ? (
            <span
              className="pointer-events-none absolute left-4 top-4 rounded-full border border-border bg-background/90 px-3 py-1 text-xs font-bold uppercase tracking-wide text-muted-foreground shadow-sm"
              style={{ opacity: dx > 0 ? progress : 0 }}
            >
              ← Back
            </span>
          ) : null}
          {hasNext ? (
            <span
              className="pointer-events-none absolute right-4 top-4 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-primary shadow-sm"
              style={{ opacity: dx < 0 ? progress : 0 }}
            >
              Next →
            </span>
          ) : null}
        </div>
      </div>

      {/* Footer: arrows + position. Hidden for a single question. */}
      {len > 1 ? (
        <div className="mt-4 flex items-center justify-center gap-4">
          <Button
            variant="tint"
            size="icon-sm"
            disabled={!hasPrev || !!releasing}
            onClick={() => go("prev")}
            aria-label="Previous question"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex items-center gap-1.5">
            {questions.map((q, i) => (
              <span
                key={q.id}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-200",
                  i === cur ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30",
                )}
              />
            ))}
          </div>
          <Button
            variant="tint"
            size="icon-sm"
            disabled={!hasNext || !!releasing}
            onClick={() => go("next")}
            aria-label="Next question"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// One question card. `interactive` cards (the top of the deck) own a draft and
// can be answered; peek cards behind are inert.
function QuestionCard({
  q,
  index,
  interactive,
  onAnswer,
}: {
  q: Question;
  index: number;
  interactive: boolean;
  onAnswer?: (text: string) => void;
}) {
  const { busy } = useAsk();
  const [draft, setDraft] = useState("");
  return (
    <div
      className={cn(
        "flex h-full select-none flex-col rounded-3xl border border-border bg-card p-5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]",
        // Entrance: the card surfacing to the top eases in. Keyed remount in the
        // stack replays this each time the deck advances.
        interactive && "animate-in fade-in zoom-in-95 duration-200 ease-out",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-[11px] font-bold text-primary">
          {index + 1}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {q.sessionId ? (
            <span className="max-w-32 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              {q.sessionId.slice(0, 8)}
            </span>
          ) : null}
          <span className="truncate">Needs your input · {timeAgo(q.createdAt)}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QuestionBody text={q.question} />
      </div>

      {interactive ? (
        <div className="mt-4 flex shrink-0 flex-col" data-no-drag>
          {q.options?.length ? (
            // Cap the option list so a long/large set scrolls instead of
            // shoving the reply box off the card; options wrap their own text.
            <div className="mb-2.5 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto overscroll-contain">
              {q.options.map((o) => (
                <Button
                  key={o}
                  variant="tint"
                  size="sm"
                  disabled={busy}
                  onClick={() => onAnswer?.(o)}
                  className="h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left"
                >
                  {o}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-1.5">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a reply…"
              rows={1}
              className="max-h-32 min-h-9 flex-1 resize-none"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onAnswer?.(draft);
                }
              }}
            />
            <Button
              size="icon-sm"
              disabled={busy || !draft.trim()}
              onClick={() => onAnswer?.(draft)}
              aria-label="Send answer"
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
