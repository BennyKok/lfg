// The human-in-the-loop reply surface. Polls /api/ask for open questions raised
// by headless agents and lets the user answer by tapping a suggested option or
// typing. Answers POST back to /api/ask/<id>/answer, which wakes the agent.
//
// Questions used to own a whole page (a swipeable card deck at /ask). They are
// a form of notification, so they now live INSIDE the Notification Center as
// time-sensitive cells pinned above the feed — one inbox, answerable in place.
// What survives here is the shared state plus the cell itself:
//   • <AskProvider/>         — the single poll loop + queue, read by everything
//   • useAsk()               — questions + answer/dismiss for the feed
//   • <AskNavButton/>        — urgency badge; opens the Notification Center
//   • <QuestionNotification/>— one answerable question card
//   • <SessionQuestionPanel/>— the owning session's in-conversation reply surface

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
import { lfgFetch } from "@/lib/lfg-client";
import { closePushNotification } from "@/lib/push";
import { MessageCircleQuestion, Send, X } from "lucide-react";

export type Question = {
  id: string;
  question: string;
  options?: string[];
  agentId?: string | null;
  sessionId?: string | null;
  createdAt: number;
};

const POLL_MS = 5000;

// Flatten markdown to a one-line plain-text preview (toasts, the collapsed
// cell). Questions written by agents often arrive full of headings and lists;
// previews should read as a sentence, not render as a document.
export function stripMd(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s*[-*+]\s+/gm, "") // list bullets
    .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*|__([^_]+)__|_([^_]+)_/g, "$1$2$3$4")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

type AskContextValue = {
  questions: Question[];
  busy: boolean;
  answer: (q: Question, text: string) => Promise<void>;
  dismiss: (q: Question) => Promise<void>;
  dismissAll: () => Promise<void>;
};

const AskContext = createContext<AskContextValue | null>(null);

export function useAsk(): AskContextValue {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk must be used within <AskProvider>");
  return ctx;
}

// Owns the single poll loop + queue so the nav badge and the Notification
// Center read one source of truth — and the feed never fetches questions a
// second time.
export function AskProvider({ children }: { children: React.ReactNode }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [busy, setBusy] = useState(false);
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
      const res = await lfgFetch(feedUrl, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { questions: Question[] };
      const qs = data.questions || [];
      // Oldest-first so we work the queue in order.
      qs.sort((a, b) => a.createdAt - b.createdAt);
      setQuestions(qs);
      for (const q of qs) {
        if (!seen.current.has(q.id)) {
          seen.current.add(q.id);
          toast("An agent needs your input", {
            description: stripMd(q.question).slice(0, 140),
          });
        }
      }
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
        const res = await lfgFetch(`/api/ask/${q.id}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: text.trim(), via: "web" }),
        });
        if (!res.ok) throw new Error(await res.text());
        // Drop it locally so the next question shows immediately; the poll
        // reconciles shortly after.
        setQuestions((prev) => prev.filter((x) => x.id !== q.id));
        void closePushNotification(`ask-${q.id}`);
        toast("Sent to the agent");
      } catch {
        toast.error("Could not send your answer");
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  // Dismissing is how a person says "I'm not answering this" — the asking agent
  // stops waiting and moves on. Clear the cell locally, and take the sticky OS
  // banner down with it so the notification doesn't outlive the question.
  const dismissOne = useCallback(async (q: Question) => {
    const res = await lfgFetch(`/api/ask/${q.id}/dismiss`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    setQuestions((prev) => prev.filter((x) => x.id !== q.id));
    void closePushNotification(`ask-${q.id}`);
  }, []);

  const dismiss = useCallback(
    async (q: Question) => {
      if (busy) return;
      setBusy(true);
      try {
        await dismissOne(q);
        toast("Question dismissed — the agent will stop waiting");
      } catch {
        toast.error("Could not dismiss the question");
      } finally {
        setBusy(false);
      }
    },
    [busy, dismissOne],
  );

  // Clearing a backlog one X at a time is the thing people actually complain
  // about, so the whole stack goes in one action. Independent requests: one
  // failure must not strand the rest.
  const dismissAll = useCallback(async () => {
    if (busy) return;
    const targets = questions;
    if (!targets.length) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(targets.map((q) => dismissOne(q)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed)
        toast.error(
          failed === targets.length
            ? "Could not dismiss the questions"
            : `Dismissed ${targets.length - failed}, ${failed} failed`,
        );
      else
        toast(
          `Dismissed ${targets.length} question${targets.length === 1 ? "" : "s"}`,
        );
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [busy, questions, dismissOne, refresh]);

  return (
    <AskContext.Provider value={{ questions, busy, answer, dismiss, dismissAll }}>
      {children}
    </AskContext.Provider>
  );
}

// Top-right island button — the urgency signal. Shows an unanswered count badge
// and a gentle pulse when agents are waiting. Tapping opens the Notification
// Center, where the questions themselves are answered.
export function AskNavButton({
  active,
  onOpen,
}: {
  active?: boolean;
  onOpen: () => void;
}) {
  const { questions } = useAsk();
  const count = questions.length;
  // Nothing waiting: this is a pure urgency affordance, so it stays out of the
  // island entirely rather than sitting there inert.
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      aria-label={`${count} question${count === 1 ? "" : "s"} for you`}
      title={`${count} waiting for you`}
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary transition-colors duration-200 ease-out active:scale-[0.96]",
      )}
    >
      {!active ? (
        <span className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
      ) : null}
      <MessageCircleQuestion className="relative size-[18px]" />
      <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground">
        {count > 9 ? "9+" : count}
      </span>
    </button>
  );
}

// Keep an ask-user question in the conversation that raised it. The same
// session can have an LFG id and a provider-native id (especially after resume),
// so callers pass both aliases and either one owns the question.
export function SessionQuestionPanel({
  sessionIds,
}: {
  sessionIds: Array<string | null | undefined>;
}) {
  const { questions } = useAsk();
  const aliases = new Set(sessionIds.filter((id): id is string => !!id));
  const matching = questions.filter((q) => !!q.sessionId && aliases.has(q.sessionId));

  if (!matching.length) return null;
  return (
    <section
      aria-label={
        matching.length === 1 ? "Question from this session" : "Questions from this session"
      }
      className="max-h-80 shrink-0 overflow-y-auto border-t border-primary/20 bg-primary/5"
    >
      {matching.map((q) => (
        <QuestionNotification key={q.id} q={q} compactPreview={false} />
      ))}
    </section>
  );
}

// One answerable question, shaped like a notification rather than a page. Rests
// collapsed at two lines; tapping the question returns to its conversation,
// while the explicit More action opens the full text and reply box in place.
// Suggested options stay visible because they are the one-tap path.
export function QuestionNotification({
  q,
  compactPreview = true,
  onOpenSession,
}: {
  q: Question;
  compactPreview?: boolean;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { busy, answer, dismiss } = useAsk();
  const [open, setOpen] = useState(!compactPreview);
  const [draft, setDraft] = useState("");

  // A new question in this slot starts fresh.
  useEffect(() => {
    setDraft("");
  }, [q.id]);

  const preview = stripMd(q.question);
  return (
    <article className="border-b border-border/50 last:border-b-0">
      <div className="flex w-full items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          <MessageCircleQuestion className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-[13px]">
            <span className="min-w-0 truncate font-semibold">Needs your input</span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {timeAgo(q.createdAt)}
            </span>
            {/* Always visible, never hover-gated. A question you cannot clear
                is a notification that owns you: it pins the nav badge, keeps a
                requireInteraction banner on the lock screen, and the person has
                no way out except answering. Reveal-on-hover also does not exist
                on the phone this is mostly read on. */}
            <button
              type="button"
              onClick={() => void dismiss(q)}
              disabled={busy}
              aria-label="Dismiss question"
              title="Dismiss — the agent stops waiting"
              className="-my-1 -mr-1.5 flex size-7 shrink-0 self-center items-center justify-center rounded-full text-muted-foreground/70 transition-[color,background-color,transform] duration-150 hover:bg-destructive/10 hover:text-destructive active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40"
            >
              <X className="size-3.5" />
            </button>
          </div>

          {open ? (
            <MessageResponse
              className={cn(
                "mt-0.5 text-[13px] leading-relaxed",
                // Demote headings: a question card must never look like a pile
                // of h1s inside a notification row.
                "[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[13px] [&_h4]:text-[13px]",
                "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
                "[&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-1.5 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1",
                "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5",
              )}
            >
              {q.question}
            </MessageResponse>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (q.sessionId && onOpenSession) onOpenSession(q.sessionId);
                else setOpen(true);
              }}
              title={q.sessionId ? "Open corresponding session" : "Show full question"}
              className="mt-0.5 block w-full text-left"
            >
              <span className="line-clamp-2 text-[13px] leading-relaxed text-foreground/90">
                {preview}
              </span>
            </button>
          )}

          {q.options?.length ? (
            <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto overscroll-contain">
              {q.options.map((o) => (
                <Button
                  key={o}
                  variant="tint"
                  size="sm"
                  disabled={busy}
                  onClick={() => void answer(q, o)}
                  className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-left text-xs"
                >
                  {o}
                </Button>
              ))}
            </div>
          ) : null}

          {open ? (
            <div className="mt-2 flex items-end gap-1.5">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a reply…"
                rows={1}
                autoFocus={compactPreview}
                className="max-h-32 min-h-9 flex-1 resize-none text-[13px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void answer(q, draft);
                  }
                }}
              />
              <Button
                size="icon-sm"
                disabled={busy || !draft.trim()}
                onClick={() => void answer(q, draft)}
                aria-label="Send answer"
              >
                <Send className="size-4" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-1.5 text-[11px] font-medium text-primary transition-opacity hover:opacity-80"
            >
              More
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function timeAgo(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
