import { BROWSER_AUTH_KINDS } from "../lib/session-ui";
import type { AgentKind, ClaudeAccountInfo, CodingAgentInfo, SetupCheckGroup } from "../App";
import { agentIconAlt, agentIconSrc } from "../lib/session-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { Check, Globe, Loader2, Play, RotateCcw, TerminalSquare, Trash2, X } from "lucide-react";
import { useState } from "react";

export default function CodingAgentsPage({
  setupChecks,
  agents,
  onVisibleChange,
  onSetup,
  onLogin,
  onAddClaudeAccount,
  onRemoveClaudeAccount,
  onSetupCheck,
  onRefresh,
}: {
  setupChecks: SetupCheckGroup[];
  agents: CodingAgentInfo[];
  onVisibleChange: (kind: AgentKind, visible: boolean) => void;
  onSetup: (kind: AgentKind) => void;
  onLogin: (kind: AgentKind, claudeAccountId?: string) => void;
  onAddClaudeAccount: () => void;
  onRemoveClaudeAccount: (account: ClaudeAccountInfo) => void;
  onSetupCheck: (key: string) => void;
  onRefresh: () => void | Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
      toast.success("Coding agents refreshed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not refresh coding agents");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-3 pb-10" data-lfg-page-column>
      <div className="flex items-center justify-between px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Coding agents
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <RotateCcw className={cn("size-3.5", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>

      {setupChecks.length ? (
        <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
          {setupChecks.map((group) => (
            <div key={group.key} className="px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-background">
                    <TerminalSquare className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{group.label}</span>
                      <Badge variant={group.configured ? "default" : "secondary"}>
                        {group.configured ? "Ready" : "Needs setup"}
                      </Badge>
                    </div>
                    <div className="mt-1 space-y-1">
                      {group.checks.map((check) => (
                        <div
                          key={check.label}
                          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                        >
                          {check.ok ? (
                            <Check className="size-3.5 shrink-0 text-success" />
                          ) : (
                            <X className="size-3.5 shrink-0 text-destructive" />
                          )}
                          <span className="shrink-0">{check.label}</span>
                          {check.detail ? (
                            <span className="min-w-0 truncate text-muted-foreground/70">
                              {check.detail}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
                {group.instructions.map((instruction) => (
                  <span key={instruction} className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {instruction}
                  </span>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!group.canAutoSetup || group.running}
                  onClick={() => onSetupCheck(group.key)}
                  title={
                    group.canAutoSetup
                      ? group.actionLabel
                      : "Install a supported coding agent first"
                  }
                >
                  {group.running ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {group.running ? "Running…" : group.actionLabel}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border bg-card/40 divide-y divide-border">
        {agents.map((agent) => {
          const configured = agent.status.configured;
          return (
            <div key={agent.key} className="px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-border bg-background">
                    <img
                      src={agentIconSrc(agent.key)}
                      alt={agentIconAlt(agent.key)}
                      className="size-5"
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{agent.label}</span>
                      <Badge variant={configured ? "default" : "secondary"}>
                        {configured ? "Ready" : "Needs setup"}
                      </Badge>
                      <Badge variant="outline">
                        {agent.status.omgCapabilityAccess === "mcp" ? "OMG tools" : "OMG prompt only"}
                      </Badge>
                    </div>
                    <div className="mt-1 space-y-1">
                      {agent.status.checks.map((check) => (
                        <div
                          key={check.label}
                          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                        >
                          {check.ok ? (
                            <Check className="size-3.5 shrink-0 text-success" />
                          ) : (
                            <X className="size-3.5 shrink-0 text-destructive" />
                          )}
                          <span className="shrink-0">{check.label}</span>
                          {check.detail ? (
                            <span className="min-w-0 truncate text-muted-foreground/70">
                              {check.detail}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <Switch
                  checked={agent.visible}
                  onCheckedChange={(visible) => onVisibleChange(agent.key, visible)}
                  aria-label={`${agent.label} visible in composer`}
                />
              </div>

              {agent.key === "aisdk" && agent.status.accounts?.length ? (
                <div className="mt-3 space-y-1.5 pl-11">
                  {agent.status.accounts.map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center gap-2 rounded-xl border border-border/70 bg-background/55 px-2.5 py-2"
                    >
                      <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                        <img src={agentIconSrc("aisdk")} alt="" className="size-4.5" />
                        <span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-foreground text-[8px] font-bold text-background ring-1 ring-background">
                          {account.number}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {account.label}
                      </span>
                      <Badge variant={account.connected ? "default" : "secondary"}>
                        {account.connected ? "Connected" : "Needs login"}
                      </Badge>
                      {!account.connected ? (
                        <Button size="sm" variant="outline" onClick={() => onLogin(agent.key, account.id)}>
                          <Globe className="size-3.5" />
                          Connect
                        </Button>
                      ) : null}
                      {account.removable ? (
                        <button
                          type="button"
                          onClick={() => onRemoveClaudeAccount(account)}
                          title={`Remove ${account.label}`}
                          aria-label={`Remove ${account.label}`}
                          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
                <div className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                  {agent.status.instructions.map((instruction) => (
                    <div key={instruction}>{instruction}</div>
                  ))}
                  {agent.status.installCommand ? (
                    <div className="truncate">
                      Install: <code>{agent.status.installCommand}</code>
                    </div>
                  ) : null}
                  {agent.status.loginCommand && !BROWSER_AUTH_KINDS.has(agent.key) ? (
                    <div className="truncate">
                      Login: <code>{agent.status.loginCommand}</code>
                    </div>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!agent.status.canAutoSetup || agent.status.setupRunning}
                  onClick={() => onSetup(agent.key)}
                  title={
                    agent.status.canAutoSetup
                      ? "Run setup for this agent"
                      : "No automatic setup is available"
                  }
                >
                  {agent.status.setupRunning ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {agent.status.setupRunning ? "Running…" : "Install"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!agent.status.canLoginInTerminal || agent.status.setupRunning}
                  onClick={() =>
                    agent.key === "aisdk" && agent.status.accounts?.some((account) => account.connected)
                      ? onAddClaudeAccount()
                      : onLogin(agent.key)
                  }
                  title={
                    BROWSER_AUTH_KINDS.has(agent.key)
                      ? `Sign in to ${agent.label} in your browser`
                      : agent.status.loginCommand
                        ? `Open terminal and run ${agent.status.loginCommand}`
                      : "No terminal login command is available"
                  }
                >
                  {BROWSER_AUTH_KINDS.has(agent.key) ? (
                    <Globe className="size-4" />
                  ) : (
                    <TerminalSquare className="size-4" />
                  )}
                  {agent.key === "aisdk" && agent.status.accounts?.some((account) => account.connected)
                    ? "Add account"
                    : "Login"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
