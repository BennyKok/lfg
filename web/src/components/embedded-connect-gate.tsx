// Embed-only first-run gate.
//
// A framed LFG hides onboarding and settings (the host owns account UX), so a
// fresh box had no surface at all for connecting a coding agent. This card is
// that surface: page one renders the browser-loginable agents, page two
// connects the tools those agents act through, and every click hands straight
// back to App's existing auth/setup handlers. Those drive the existing
// agent/connection endpoints and the same <CodingAgentAuthDialog> the Settings
// page uses. No credentials, no second auth path, no progress bar.
// Once opened, the card stays mounted through both pages so a successful agent
// login cannot make the tool step disappear underneath the user.

import { useState } from "react";
import { Check, Github } from "lucide-react";
import { Button } from "./ui/button";
import type { ConnectOption, ToolConnectOption } from "../lib/embedded-connect";
import { LFG_SMALL_ICON_PATH } from "../lib/icon-assets";
import { omgAssetUrl } from "../lib/omg-client";

export function EmbeddedConnectGate({
  options,
  toolConnections,
  pendingKind,
  onConnect,
  onInstall,
  onConnectTool,
  onDone,
}: {
  options: ConnectOption[];
  toolConnections?: ToolConnectOption[];
  /** Kind with an in-flight connect/install click, if any. */
  pendingKind?: string | null;
  onConnect: (kind: string) => void;
  onInstall: (kind: string) => void;
  onConnectTool: (key: ToolConnectOption["key"]) => void;
  onDone: () => void;
}) {
  const [page, setPage] = useState<"agents" | "tools">("agents");
  const hasConnectedAgent = options.some((option) => option.configured);

  return (
    <div
      className="flex flex-col items-center overflow-y-auto overscroll-none bg-background px-6 text-foreground"
      style={{ height: "var(--lfg-app-height, 100dvh)" }}
    >
      <div className="my-auto w-full max-w-sm py-6">
        <div className="mb-4 flex items-center justify-between gap-2">
          <img
            src={omgAssetUrl(LFG_SMALL_ICON_PATH)}
            alt="lfg"
            className="size-7 shrink-0"
          />
          <div
            className="flex items-center gap-1.5"
            aria-label={`Step ${page === "agents" ? 1 : 2} of 2`}
          >
            <span
              className={`h-1.5 rounded-full transition-all duration-300 ease-ios ${page === "agents" ? "w-5 bg-primary" : "w-1.5 bg-primary/40"}`}
            />
            <span
              className={`h-1.5 rounded-full transition-all duration-300 ease-ios ${page === "tools" ? "w-5 bg-primary" : "w-1.5 bg-foreground/10"}`}
            />
          </div>
        </div>
        {page === "agents" ? (
          <>
            <h1 className="text-xl font-semibold">Connect a coding agent</h1>
            <p className="mb-5 mt-1 text-sm text-muted-foreground">
              Sign in once and this Computer can start sessions. It opens the
              provider&rsquo;s sign-in page — nothing is stored here.
            </p>
            <div className="flex flex-col gap-2">
              {options.map((option) => {
                const pending = pendingKind === option.kind;
                const needsInstall = !option.installed;
                const blocked = needsInstall && !option.canAutoSetup;
                const providerLabel = option.provider === "claude"
                  ? "Claude"
                  : option.provider === "codex"
                    ? "ChatGPT"
                    : "xAI";
                return (
                  <div
                    key={option.kind}
                    className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{option.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {option.configured
                          ? "Connected"
                          : blocked
                            ? "CLI not installed on this Computer"
                            : needsInstall
                              ? "Install first, then sign in"
                              : `Sign in with ${providerLabel}`}
                      </span>
                    </span>
                    {option.configured ? (
                      <span className="flex size-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500" aria-label="Connected">
                        <Check className="size-4" />
                      </span>
                    ) : (
                      <Button
                        variant={option.provider === "claude" ? "brand" : "outline"}
                        size="sm"
                        disabled={pending || blocked}
                        onClick={() =>
                          needsInstall ? onInstall(option.kind) : onConnect(option.kind)
                        }
                      >
                        {pending ? (
                          <span className="size-2 animate-pulse rounded-full bg-current" />
                        ) : needsInstall ? (
                          "Install"
                        ) : (
                          "Connect"
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            {hasConnectedAgent ? (
              <Button
                variant="brand"
                className="mt-4 w-full"
                onClick={() => setPage("tools")}
              >
                Continue
              </Button>
            ) : null}
            <button
              type="button"
              onClick={() => setPage("tools")}
              className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {hasConnectedAgent ? "Connect another later" : "Skip for now"}
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Connect your tools</h1>
            <p className="mb-5 mt-1 text-sm text-muted-foreground">
              Connect GitHub for private repos, pushes, and pull requests. You
              can always do this later from the Terminal.
            </p>
            <div className="flex flex-col gap-2">
              {!toolConnections ? (
                <div className="h-[58px] animate-pulse rounded-xl border border-border bg-muted/40" />
              ) : toolConnections.map((tool) => {
                const pending = pendingKind === tool.key;
                return (
                  <div
                    key={tool.key}
                    className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5">
                      <Github className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{tool.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {!tool.installed
                          ? "GitHub CLI is not installed"
                          : tool.connected
                            ? "Connected for private repos and PRs"
                            : tool.detail}
                      </span>
                    </span>
                    {tool.connected ? (
                      <span className="flex size-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500" aria-label="Connected">
                        <Check className="size-4" />
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending || !tool.installed}
                        onClick={() => onConnectTool(tool.key)}
                      >
                        {pending ? (
                          <span className="size-2 animate-pulse rounded-full bg-current" />
                        ) : (
                          "Connect"
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
            <Button variant="brand" className="mt-4 w-full" onClick={onDone}>
              Open my Computer
            </Button>
            <button
              type="button"
              onClick={() => setPage("agents")}
              className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
}
