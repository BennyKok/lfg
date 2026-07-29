import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  type LfgClient,
  type LfgConnectionState,
  type LfgMessage,
  type LfgSession,
  type LfgTranscriptEvent,
} from "@lfg-dev/client";

const ClientContext = createContext<LfgClient | null>(null);

export interface LfgProviderProps {
  client: LfgClient;
  children: ReactNode;
}

export function LfgProvider({ client, children }: LfgProviderProps) {
  return (
    <ClientContext.Provider value={client}>
      {children}
    </ClientContext.Provider>
  );
}

export function useLfgClient(): LfgClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useLfgClient must be used inside LfgProvider");
  return client;
}

export interface LfgComputerSurfaceProps {
  className?: string;
  title?: string;
  selectedSessionId?: string | null;
  onSelectedSessionChange?: (sessionId: string) => void;
  onNewSession?: () => void;
  onOpenFullComputer?: () => void;
  pollIntervalMs?: number;
}

function sessionTitle(session: LfgSession): string {
  return (
    session.title?.trim() ||
    session.lastUserText?.trim() ||
    session.project?.trim() ||
    "Untitled session"
  );
}

function sessionSubtitle(session: LfgSession): string {
  const agent = session.agentLabel || session.agent || "Agent";
  return session.project ? `${agent} · ${session.project}` : agent;
}

function sortSessions(sessions: LfgSession[]): LfgSession[] {
  return [...sessions]
    .filter((session): session is LfgSession & { sessionId: string } => !!session.sessionId)
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? b.startedAt ?? 0) -
        (a.lastActivityAt ?? a.startedAt ?? 0),
    );
}

function messageKey(message: LfgMessage, index: number): string {
  return (
    message.id ||
    `${message.role ?? "unknown"}:${message.kind ?? "unknown"}:${message.ts ?? index}:${index}`
  );
}

function mergeMessage(messages: LfgMessage[], incoming: LfgMessage): LfgMessage[] {
  const withoutMatchingOptimistic =
    incoming.role === "user" && incoming.text
      ? messages.filter(
          (message) =>
            !(
              message.pending &&
              message.role === "user" &&
              message.text?.trim() === incoming.text?.trim()
            ),
        )
      : messages;
  if (!incoming.id) return [...withoutMatchingOptimistic, incoming].slice(-100);
  const index = withoutMatchingOptimistic.findIndex(
    (message) => message.id === incoming.id,
  );
  if (index < 0) return [...withoutMatchingOptimistic, incoming].slice(-100);
  const next = [...withoutMatchingOptimistic];
  next[index] = { ...next[index], ...incoming };
  return next;
}

function applyTranscriptEvent(
  messages: LfgMessage[],
  event: LfgTranscriptEvent,
): LfgMessage[] {
  if (event.type === "snapshot") {
    const optimistic = messages.filter((message) => message.pending);
    return [...event.messages, ...optimistic].slice(-100);
  }
  if (event.type === "message") return mergeMessage(messages, event.message);
  if (event.type !== "ai_part") return messages;
  const part = event.part;
  if (part.type !== "text-delta" || !part.id) return messages;
  const existing = messages.find((message) => message.id === part.id);
  const text = part.reset
    ? part.text ?? part.delta ?? ""
    : `${existing?.text ?? ""}${part.delta ?? ""}`;
  if (!text) return messages;
  return mergeMessage(messages, {
    id: part.id,
    role: "assistant",
    kind: "text",
    text,
    ts: part.ts ?? Date.now(),
  });
}

function ComputerSkeleton() {
  return (
    <div className="lfgc-skeleton" aria-label="Loading Computer">
      <div className="lfgc-skeleton-sidebar">
        {[0, 1, 2, 3].map((item) => (
          <div className="lfgc-skeleton-row" key={item}>
            <span className="lfgc-skeleton-dot" />
            <span className="lfgc-skeleton-lines">
              <span />
              <span />
            </span>
          </div>
        ))}
      </div>
      <div className="lfgc-skeleton-thread">
        <span className="lfgc-skeleton-bubble lfgc-skeleton-bubble-user" />
        <span className="lfgc-skeleton-bubble" />
        <span className="lfgc-skeleton-bubble lfgc-skeleton-bubble-short" />
      </div>
    </div>
  );
}

function StatusDot({
  busy,
  connection,
}: {
  busy: boolean;
  connection: LfgConnectionState;
}) {
  const state = busy
    ? "working"
    : connection.status === "live"
      ? "online"
      : connection.status;
  return (
    <span
      className={`lfgc-status-dot lfgc-status-dot-${state}`}
      aria-label={state}
      title={state}
    />
  );
}

function EmptyComputer({
  onNewSession,
  onOpenFullComputer,
}: Pick<LfgComputerSurfaceProps, "onNewSession" | "onOpenFullComputer">) {
  return (
    <div className="lfgc-empty">
      <div className="lfgc-empty-orb" aria-hidden="true">
        <span />
      </div>
      <h2>Your Computer is ready</h2>
      <p>Start a session and keep working here while LFG runs on your machine.</p>
      <div className="lfgc-empty-actions">
        {onNewSession ? (
          <button className="lfgc-button lfgc-button-primary" onClick={onNewSession}>
            New session
          </button>
        ) : null}
        {onOpenFullComputer ? (
          <button className="lfgc-button" onClick={onOpenFullComputer}>
            Open tools
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function LfgComputerSurface({
  className,
  title = "Computer",
  selectedSessionId: controlledSessionId,
  onSelectedSessionChange,
  onNewSession,
  onOpenFullComputer,
  pollIntervalMs = 5_000,
}: LfgComputerSurfaceProps) {
  const client = useLfgClient();
  const cached = client.peekSessions();
  const [sessions, setSessions] = useState<LfgSession[] | null>(
    cached ? sortSessions(cached) : null,
  );
  const [internalSessionId, setInternalSessionId] = useState<string | null>(
    controlledSessionId ?? null,
  );
  const [messages, setMessages] = useState<LfgMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<LfgConnectionState>(
    client.live.state,
  );
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const selectedSessionId = controlledSessionId ?? internalSessionId;
  const selectedSession =
    sessions?.find((session) => session.sessionId === selectedSessionId) ?? null;

  const selectSession = useCallback(
    (sessionId: string) => {
      if (controlledSessionId === undefined) setInternalSessionId(sessionId);
      onSelectedSessionChange?.(sessionId);
    },
    [controlledSessionId, onSelectedSessionChange],
  );

  const refreshSessions = useCallback(async () => {
    try {
      const next = sortSessions(await client.listSessions());
      setSessions(next);
      setError(null);
      const requested = controlledSessionId ?? internalSessionId;
      if (!requested && next[0]?.sessionId) selectSession(next[0].sessionId);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Couldn’t reach your Computer.",
      );
      setSessions((current) => current ?? []);
    }
  }, [
    client,
    controlledSessionId,
    internalSessionId,
    selectSession,
  ]);

  useEffect(() => {
    void refreshSessions();
    const interval = window.setInterval(() => {
      void refreshSessions();
    }, pollIntervalMs);
    return () => window.clearInterval(interval);
  }, [pollIntervalMs, refreshSessions]);

  useEffect(
    () => client.live.subscribeConnection(setConnection),
    [client],
  );

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      setBusy(false);
      return;
    }
    let active = true;
    setMessagesLoading(true);
    setMessages([]);
    setBusy(!!selectedSession?.busy);
    void client.getMessages(selectedSessionId).then(
      (response) => {
        if (!active) return;
        setMessages(Array.isArray(response.messages) ? response.messages : []);
        setMessagesLoading(false);
      },
      (loadError) => {
        if (!active) return;
        setMessagesLoading(false);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Couldn’t load this session.",
        );
      },
    );
    const unsubscribe = client.live.subscribeTranscript(
      selectedSessionId,
      (event) => {
        if (!active) return;
        if (event.type === "busy") setBusy(event.busy);
        if (event.type === "error") setError(event.error);
        setMessages((current) => applyTranscriptEvent(current, event));
        if (event.type === "snapshot") setMessagesLoading(false);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, selectedSession?.busy, selectedSessionId]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = composer.trim();
    if (!selectedSessionId || !text || sending) return;
    setComposer("");
    setSending(true);
    setBusy(true);
    const optimistic: LfgMessage = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      kind: "text",
      text,
      ts: Date.now(),
      pending: true,
    };
    setMessages((current) => [...current, optimistic].slice(-100));
    try {
      await client.sendMessage(selectedSessionId, text);
      setError(null);
    } catch (sendError) {
      setMessages((current) =>
        current.map((message) =>
          message.id === optimistic.id
            ? { ...message, pending: false, title: "Couldn’t send" }
            : message,
        ),
      );
      setError(
        sendError instanceof Error ? sendError.message : "Couldn’t send.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <section className={`lfgc-root ${className ?? ""}`} aria-label={title}>
      <header className="lfgc-header">
        <div className="lfgc-brand">
          <span className="lfgc-brand-mark" aria-hidden="true">
            <span />
          </span>
          <div>
            <h1>{title}</h1>
            <p>
              {connection.status === "live"
                ? "Connected"
                : connection.status === "offline"
                  ? "Computer offline"
                  : "Connecting"}
            </p>
          </div>
        </div>
        <div className="lfgc-header-actions">
          {onOpenFullComputer ? (
            <button
              className="lfgc-icon-button"
              onClick={onOpenFullComputer}
              aria-label="Open Computer tools"
              title="Open Computer tools"
            >
              •••
            </button>
          ) : null}
          {onNewSession ? (
            <button
              className="lfgc-icon-button lfgc-icon-button-primary"
              onClick={onNewSession}
              aria-label="New session"
              title="New session"
            >
              +
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="lfgc-error" role="status">
          <span>{error}</span>
          <button onClick={() => void refreshSessions()}>Try again</button>
        </div>
      ) : null}

      {sessions === null ? (
        <ComputerSkeleton />
      ) : sessions.length === 0 ? (
        <EmptyComputer
          onNewSession={onNewSession}
          onOpenFullComputer={onOpenFullComputer}
        />
      ) : (
        <div className="lfgc-workspace">
          <nav className="lfgc-sessions" aria-label="Sessions">
            <div className="lfgc-sessions-heading">
              <span>Live sessions</span>
              <span>{sessions.length}</span>
            </div>
            <div className="lfgc-session-list">
              {sessions.map((session) => {
                const id = session.sessionId!;
                const selected = id === selectedSessionId;
                return (
                  <button
                    key={id}
                    className={`lfgc-session-row ${selected ? "lfgc-session-row-selected" : ""}`}
                    onClick={() => selectSession(id)}
                    aria-current={selected ? "page" : undefined}
                  >
                    <StatusDot
                      busy={!!session.busy}
                      connection={connection}
                    />
                    <span className="lfgc-session-copy">
                      <strong>{sessionTitle(session)}</strong>
                      <small>{sessionSubtitle(session)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          <main className="lfgc-thread">
            <div className="lfgc-thread-heading">
              <div>
                <h2>
                  {selectedSession
                    ? sessionTitle(selectedSession)
                    : "Select a session"}
                </h2>
                <p>
                  {selectedSession
                    ? sessionSubtitle(selectedSession)
                    : "Your work stays live here."}
                </p>
              </div>
              {selectedSessionId && busy ? (
                <button
                  className="lfgc-stop-button"
                  onClick={() => void client.interrupt(selectedSessionId)}
                >
                  Stop
                </button>
              ) : null}
            </div>

            <div className="lfgc-messages" aria-live="polite">
              {messagesLoading && messages.length === 0 ? (
                <div className="lfgc-message-skeletons">
                  <span className="lfgc-skeleton-bubble lfgc-skeleton-bubble-user" />
                  <span className="lfgc-skeleton-bubble" />
                </div>
              ) : null}
              {!messagesLoading && messages.length === 0 ? (
                <div className="lfgc-thread-empty">
                  <span>Ready when you are.</span>
                </div>
              ) : null}
              {messages.map((message, index) => {
                const user = message.role === "user";
                const thinking = message.kind === "thinking";
                return (
                  <article
                    className={`lfgc-message ${user ? "lfgc-message-user" : ""} ${thinking ? "lfgc-message-thinking" : ""}`}
                    key={messageKey(message, index)}
                  >
                    {!user ? (
                      <span className="lfgc-message-avatar" aria-hidden="true">
                        <span />
                      </span>
                    ) : null}
                    <div className="lfgc-message-body">
                      {message.name && message.kind !== "text" ? (
                        <strong className="lfgc-message-attachment">
                          {message.name}
                        </strong>
                      ) : null}
                      <p>{message.text || (thinking ? "Thinking…" : "")}</p>
                      {message.pending ? <small>Sending…</small> : null}
                    </div>
                  </article>
                );
              })}
              {busy &&
              !messages.some((message) => message.kind === "thinking") ? (
                <div className="lfgc-working" aria-label="Agent is working">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              <div ref={threadEndRef} />
            </div>

            <form className="lfgc-composer" onSubmit={submit}>
              <textarea
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={
                  selectedSessionId
                    ? "Message your agent"
                    : "Select a session first"
                }
                disabled={!selectedSessionId}
                rows={1}
              />
              <button
                type="submit"
                disabled={!selectedSessionId || !composer.trim() || sending}
                aria-label="Send message"
              >
                ↑
              </button>
            </form>
          </main>
        </div>
      )}
    </section>
  );
}

export function createLfgComputerSurface(
  client: LfgClient,
  props: LfgComputerSurfaceProps = {},
) {
  return (
    <LfgProvider client={client}>
      <LfgComputerSurface {...props} />
    </LfgProvider>
  );
}
