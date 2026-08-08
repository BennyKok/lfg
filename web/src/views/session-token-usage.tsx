import type { Session } from "../App";
import { titleForSession } from "../lib/session-ui";
import { api } from "../lib/omg-client";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Gauge, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type SessionTokenUsage = {
  available: boolean;
  source: "claude-context" | "codex-transcript" | "claude-transcript" | "unavailable";
  accuracy: "reported" | "mixed" | "unavailable";
  updatedAt: number;
  model: string | null;
  context: {
    used: number | null;
    max: number | null;
    free: number | null;
    percent: number | null;
  };
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
    costUsd: number | null;
  } | null;
  categories: Array<{
    name: string;
    tokens: number;
    color?: string;
    accuracy: "reported" | "estimated";
  }>;
  details?: {
    memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
    mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
    systemTools?: Array<{ name: string; tokens: number }>;
    systemPromptSections?: Array<{ name: string; tokens: number }>;
    skills?: {
      totalSkills: number;
      includedSkills: number;
      tokens: number;
      items: Array<{ name: string; source: string; tokens: number }>;
    };
    messageBreakdown?: {
      toolCallTokens: number;
      toolResultTokens: number;
      attachmentTokens: number;
      assistantMessageTokens: number;
      userMessageTokens: number;
      redirectedContextTokens: number;
      unattributedTokens: number;
      toolCallsByType: Array<{ name: string; callTokens: number; resultTokens: number }>;
    };
  };
  note: string;
};

function TokenUsageDetailList({
  title,
  items,
}: {
  title: string;
  items: Array<{ name: string; detail?: string; tokens: number }>;
}) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="divide-y divide-border rounded-xl border border-border bg-muted/20 px-3">
        {items.map((item, index) => (
          <div key={`${item.name}-${index}`} className="flex items-center gap-3 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{item.name}</div>
              {item.detail ? (
                <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
              ) : null}
            </div>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {formatTokenCount(item.tokens)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatTokenCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return Math.round(value).toLocaleString();
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

export default function SessionTokenUsageDialog({
  session,
  open,
  onOpenChange,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sid = session.sessionId;
  const [usage, setUsage] = useState<SessionTokenUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sid) return;
    setLoading(true);
    setError(null);
    try {
      setUsage(await api<SessionTokenUsage>(`/api/sessions/${sid}/token-usage`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn’t load token usage");
    } finally {
      setLoading(false);
    }
  }, [sid]);

  useEffect(() => {
    if (!open || usage || loading) return;
    void load();
  }, [load, loading, open, usage]);

  const categoryTotal = usage?.categories.reduce((sum, category) => sum + category.tokens, 0) ?? 0;
  const categoryDenominator = Math.max(categoryTotal, usage?.context.used ?? 0, 1);
  const contextPercent =
    usage?.context.percent ??
    (usage?.context.used != null && usage.context.max
      ? (usage.context.used / usage.context.max) * 100
      : null);
  const detail = usage?.details;
  const messageBreakdown = detail?.messageBreakdown;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next && usage) void load();
      }}
    >
        <DialogContent
          className="max-h-[88dvh] overflow-hidden sm:max-w-xl"
          innerClassName="flex max-h-[88dvh] flex-col gap-0 p-0"
        >
          <DialogHeader className="border-b border-border px-5 pb-4 pt-5 text-left">
            <DialogTitle className="flex items-center gap-2">
              <Gauge className="size-5" />
              Session token usage
            </DialogTitle>
            <DialogDescription>
              Current context and cumulative model traffic for {titleForSession(session)}.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-6">
            {loading && !usage ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Reading session usage…
              </div>
            ) : error && !usage ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                {error}
              </div>
            ) : usage && !usage.available ? (
              <div className="rounded-2xl border border-border bg-muted/30 p-5">
                <div className="font-medium">Token data isn’t available for this agent yet</div>
                <p className="mt-1 text-sm text-muted-foreground">{usage.note}</p>
              </div>
            ) : usage ? (
              <>
                <section className="space-y-3 pt-1">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Current context
                      </div>
                      <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
                        {formatTokenCount(usage.context.used)}
                        {usage.context.max != null ? (
                          <span className="ml-1 text-base font-normal text-muted-foreground">
                            / {formatTokenCount(usage.context.max)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {contextPercent != null ? (
                      <div className="text-right">
                        <div className="text-xl font-semibold tabular-nums">
                          {Math.round(contextPercent)}%
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatTokenCount(usage.context.free)} free
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {usage.context.max != null && usage.context.used != null ? (
                    <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <div
                        className="h-full rounded-full bg-foreground transition-[width]"
                        style={{ width: `${Math.min(100, Math.max(0, contextPercent ?? 0))}%` }}
                      />
                    </div>
                  ) : null}
                </section>

                {usage.categories.length ? (
                  <section className="space-y-3">
                    <div className="flex h-3 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      {usage.categories.map((category, index) => (
                        <span
                          key={`${category.name}-${index}`}
                          style={{
                            width: `${(category.tokens / categoryDenominator) * 100}%`,
                            backgroundColor: category.color || `hsl(${(index * 47) % 360} 70% 60%)`,
                          }}
                        />
                      ))}
                    </div>
                    <div className="grid gap-1 sm:grid-cols-2">
                      {usage.categories.map((category, index) => (
                        <div
                          key={`${category.name}-${index}`}
                          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm"
                        >
                          <span
                            className="size-2.5 shrink-0 rounded-sm"
                            style={{
                              backgroundColor:
                                category.color || `hsl(${(index * 47) % 360} 70% 60%)`,
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate">{category.name}</span>
                          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                            {formatTokenCount(category.tokens)}
                            {category.accuracy === "estimated" ? " ~" : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                {usage.totals ? (
                  <section className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Session totals
                    </h3>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {[
                        ["Input", usage.totals.input],
                        ["Output", usage.totals.output],
                        ["Cache read", usage.totals.cacheRead],
                        ["Cache write", usage.totals.cacheWrite],
                        ["Reasoning", usage.totals.reasoning],
                        ["All traffic", usage.totals.total],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-xl border border-border bg-muted/25 p-3">
                          <div className="text-xs text-muted-foreground">{label}</div>
                          <div className="mt-1 font-mono text-base font-semibold tabular-nums">
                            {formatTokenCount(value as number)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                <TokenUsageDetailList
                  title="Skills"
                  items={(detail?.skills?.items ?? []).map((item) => ({
                    name: item.name,
                    detail: item.source,
                    tokens: item.tokens,
                  }))}
                />
                <TokenUsageDetailList
                  title="System prompt"
                  items={(detail?.systemPromptSections ?? []).map((item) => ({
                    name: item.name,
                    tokens: item.tokens,
                  }))}
                />
                <TokenUsageDetailList
                  title="MCP tools"
                  items={(detail?.mcpTools ?? []).map((item) => ({
                    name: item.name,
                    detail: `${item.serverName}${item.isLoaded === false ? " · deferred" : ""}`,
                    tokens: item.tokens,
                  }))}
                />
                <TokenUsageDetailList
                  title="Memory files"
                  items={(detail?.memoryFiles ?? []).map((item) => ({
                    name: item.path,
                    detail: item.type,
                    tokens: item.tokens,
                  }))}
                />
                {messageBreakdown ? (
                  <TokenUsageDetailList
                    title="Messages"
                    items={[
                      { name: "User messages", tokens: messageBreakdown.userMessageTokens },
                      { name: "Assistant messages", tokens: messageBreakdown.assistantMessageTokens },
                      { name: "Tool calls", tokens: messageBreakdown.toolCallTokens },
                      { name: "Tool results", tokens: messageBreakdown.toolResultTokens },
                      { name: "Attachments", tokens: messageBreakdown.attachmentTokens },
                    ].filter((item) => item.tokens > 0)}
                  />
                ) : null}

                <div className="rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
                  <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        usage.accuracy === "reported" ? "bg-emerald-500" : "bg-amber-500",
                      )}
                    />
                    {usage.accuracy === "reported"
                      ? "Provider-reported breakdown"
                      : "Reported totals · estimated categories"}
                  </div>
                  {usage.note}
                  {usage.model ? ` Model: ${usage.model}.` : ""}
                </div>
              </>
            ) : null}
          </div>
        </DialogContent>
    </Dialog>
  );
}
