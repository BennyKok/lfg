import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Session = {
  agent?: string;
  title?: string | null;
  lastUserText?: string | null;
  sessionId: string | null;
  startedAt?: number | null;
  lastActivityAt?: number | null;
  last?: { role?: string; kind?: string; text?: string; ts?: number };
  busy?: boolean;
  status?: "ok" | "blocked";
  statusReason?: "model_unavailable" | "out_of_credits" | "provider_auth" | "provider_error" | null;
  statusDetail?: string | null;
  model?: string | null;
};

type Message = {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  html?: string;
  ts?: number;
  url?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  caption?: string;
  alt?: string;
  pending?: boolean;
  seed?: boolean;
  catchUp?: boolean;
};

type AiStreamPart = {
  type: "text-delta" | "text-start" | "text-end" | "error" | string;
  id?: string;
  delta?: string;
  text?: string;
  reset?: boolean;
  ts?: number;
};

type PromptOption = { index: number; label: string; selected?: boolean };
type SessionPrompt = { question?: string; options: PromptOption[] };
type QueueMsg = {
  id: string;
  text: string;
  status: "pending" | "sending" | "queued" | "failed" | "delivered";
  error?: string;
};
type LoadOlderMessages = (sid: string) => Promise<boolean>;
type StatusRow = Pick<
  Session,
  | "sessionId"
  | "busy"
  | "title"
  | "lastUserText"
  | "lastActivityAt"
  | "status"
  | "statusReason"
  | "statusDetail"
  | "model"
>;

type LiveWsMessage =
  | { t: "batch"; sid: string; messages?: Message[]; nextBefore?: number | null }
  | { t: "msg"; sid: string; message?: Message; m?: Message }
  | { t: "ai_part"; sid: string; part?: AiStreamPart }
  | { t: "busy"; sid: string; busy?: boolean }
  | { t: "prompt"; sid: string; prompt?: SessionPrompt | null }
  | { t: "queue"; sid: string; queue?: QueueMsg[] }
  | { t: "page"; sid: string; messages?: Message[]; nextBefore?: number | null; hasMore?: boolean }
  | { t: "status"; rows?: StatusRow[] }
  | { t: "ping" }
  | { t: "error"; sid?: string; message?: string };

const DRAFT_CATCHUP_MIN_CHARS = 160;

declare global {
  interface Window {
    __LFG_CONFIG__?: { liveTransport?: string };
  }
}

export function liveTransportMode(): "sse" | "ws" {
  const runtime = typeof window !== "undefined" ? window.__LFG_CONFIG__?.liveTransport : undefined;
  const build = import.meta.env.VITE_LIVE_TRANSPORT;
  return runtime === "ws" || build === "ws" ? "ws" : "sse";
}

function evlog(event: string, fields: Record<string, unknown> = {}) {
  try {
    const payload = JSON.stringify({
      event,
      source: "browser",
      pageMs: Math.round(performance.now() * 1000) / 1000,
      path: location.pathname + location.search,
      ...fields,
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon("/api/evlog", blob)) return;
    }
    void fetch("/api/evlog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data as T;
}

function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
}

function normText(value?: string) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function messageNeedle(value?: string) {
  return normText(value).slice(0, 48);
}

function sameMessageNeedle(a?: string, b?: string) {
  const an = messageNeedle(a);
  const bn = messageNeedle(b);
  if (!an || !bn) return false;
  return an.includes(bn) || bn.includes(an);
}

function seedMessageForSession(session: Session): Message | null {
  const sid = session.sessionId;
  const last = session.last;
  const lastIsProse =
    last?.kind === "text" && (last.role === "assistant" || last.role === "user") && !!last.text;
  const text = normText(lastIsProse ? last.text : session.lastUserText || "");
  if (!sid || !text) return null;
  const role = lastIsProse && last.role === "assistant" ? "assistant" : "user";
  const ts = (lastIsProse ? last.ts : null) ?? session.lastActivityAt ?? session.startedAt ?? Date.now();
  return {
    id: `seed-${sid}-${ts}-${role}`,
    role,
    kind: "text",
    text,
    html: escapeHtml(text).replace(/\n/g, "<br>"),
    ts,
    seed: true,
  };
}

function isDraftAssistantMessage(message: Message) {
  return (
    message.role === "assistant" &&
    message.kind === "text" &&
    typeof message.id === "string" &&
    message.id.startsWith("draft-")
  );
}

function collapseThinkingRuns(messages: Message[]) {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.kind === "thinking" && out[out.length - 1]?.kind === "thinking") out[out.length - 1] = message;
    else out.push(message);
  }
  return out;
}

function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 10_000;
// Consecutive failed reconnect attempts after which we stop calling it a brief
// "reconnecting" blip and surface the more alarming "offline" state instead.
const OFFLINE_AFTER_ATTEMPTS = 5;

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "offline";
export type ConnectionState = {
  status: ConnectionStatus;
  attempt: number;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastMessageAt: number | null;
};

const INITIAL_CONNECTION_STATE: ConnectionState = {
  status: "connecting",
  attempt: 0,
  lastCloseCode: null,
  lastCloseReason: null,
  lastMessageAt: null,
};

export function useLiveSocket(
  sessions: Session[],
  streamIds: string[],
  opts: { enabled?: boolean; onStatusRows?: (rows: StatusRow[]) => void } = {},
) {
  const enabled = opts.enabled ?? liveTransportMode() === "ws";
  const onStatusRowsRef = useRef(opts.onStatusRows);
  useEffect(() => {
    onStatusRowsRef.current = opts.onStatusRows;
  }, [opts.onStatusRows]);

  const ids = useMemo(() => streamIds.filter((id): id is string => !!id), [streamIds]);
  const streamKey = ids.join(",");
  const listBusy = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const session of sessions) if (session.sessionId) map[session.sessionId] = !!session.busy;
    return map;
  }, [sessions]);
  const seedBySid = useMemo(() => {
    const map: Record<string, Message> = {};
    for (const session of sessions) {
      const seed = seedMessageForSession(session);
      if (session.sessionId && seed) map[session.sessionId] = seed;
    }
    return map;
  }, [sessions]);

  const [messagesBySid, setMessagesBySid] = useState<Record<string, Message[]>>({});
  const [busyBySid, setBusyBySid] = useState<Record<string, boolean>>({});
  const [promptsBySid, setPromptsBySid] = useState<Record<string, SessionPrompt | null>>({});
  const [queuesBySid, setQueuesBySid] = useState<Record<string, QueueMsg[]>>({});
  const [loadingBySid, setLoadingBySid] = useState<Record<string, boolean>>({});
  const [nextBeforeBySid, setNextBeforeBySid] = useState<Record<string, number | null>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const desiredRef = useRef<Set<string>>(new Set());
  const subscribedRef = useRef<Set<string>>(new Set());
  const seenRef = useRef<Record<string, Set<string>>>({});
  const messagesRef = useRef(messagesBySid);
  const nextBeforeRef = useRef(nextBeforeBySid);
  const thinkTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const firstMsgRef = useRef<Set<string>>(new Set());
  const draftSeenRef = useRef<Set<string>>(new Set());
  const openAtRef = useRef(0);
  const reconnectsRef = useRef(0);
  const closedByHookRef = useRef(false);
  const backoffRef = useRef(BACKOFF_MIN_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReconnectRef = useRef(false);
  const lastMessageFlushRef = useRef(0);
  const connectRef = useRef<() => void>(() => {});

  const [connection, setConnection] = useState<ConnectionState>(INITIAL_CONNECTION_STATE);

  useEffect(() => {
    messagesRef.current = messagesBySid;
  }, [messagesBySid]);
  useEffect(() => {
    nextBeforeRef.current = nextBeforeBySid;
  }, [nextBeforeBySid]);

  const send = useCallback((payload: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const markFirst = useCallback((sid: string, message: Message, batch = false, count?: number) => {
    if (firstMsgRef.current.has(sid)) return;
    firstMsgRef.current.add(sid);
    evlog("ws_client_first_msg", {
      sid,
      kind: message.kind,
      role: message.role,
      batch,
      count,
      elapsedMs: Math.round((performance.now() - openAtRef.current) * 1000) / 1000,
    });
  }, []);

  const handleMessage = useCallback((payload: LiveWsMessage) => {
    if (payload.t === "ping") {
      send({ t: "pong" });
      return;
    }
    if (payload.t === "status") {
      if (Array.isArray(payload.rows)) onStatusRowsRef.current?.(payload.rows);
      return;
    }
    if (payload.t === "error") return;
    const sid = "sid" in payload ? payload.sid : undefined;
    if (!sid || !desiredRef.current.has(sid)) return;

    if (payload.t === "batch") {
      const messages = collapseThinkingRuns(Array.isArray(payload.messages) ? payload.messages : []);
      if (messages.length) markFirst(sid, messages[0], true, messages.length);
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
      for (const message of messages) if (message.id && message.kind !== "thinking") seen.add(message.id);
      if (seen.size > 800) seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
      setNextBeforeBySid((prev) => ({ ...prev, [sid]: payload.nextBefore ?? null }));
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        const pending = current.filter((item) => {
          if (!item.pending) return false;
          const pendingNeedle = messageNeedle(item.text);
          if (!pendingNeedle) return true;
          return !messages.some((message) => message.role === "user" && message.kind === "text" && sameMessageNeedle(message.text, pendingNeedle));
        });
        return { ...prev, [sid]: [...messages, ...pending].slice(-80) };
      });
      return;
    }

    if (payload.t === "msg") {
      const message = payload.message ?? payload.m;
      if (!message) return;
      markFirst(sid, message);
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      if (message.id && message.kind !== "thinking") {
        const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
        if (seen.has(message.id)) return;
        seen.add(message.id);
        if (seen.size > 800) seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
      }
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        const next = message.kind === "thinking"
          ? [...current.filter((item) => item.kind !== "thinking"), message]
          : [
              ...current.filter((item) => {
                if (message.role === "user" && message.kind === "text") {
                  return !item.pending || !sameMessageNeedle(message.text, item.text);
                }
                if (item.kind === "thinking") return false;
                if (message.role === "assistant" && message.kind === "text" && isDraftAssistantMessage(item)) return false;
                return true;
              }),
              message,
            ];
        return { ...prev, [sid]: next.slice(-80) };
      });
      const timers = thinkTimerRef.current;
      if (timers[sid]) clearTimeout(timers[sid]);
      if (message.kind === "thinking") {
        timers[sid] = setTimeout(() => {
          delete timers[sid];
          setMessagesBySid((prev) => {
            const cur = prev[sid];
            if (!cur?.some((item) => item.kind === "thinking")) return prev;
            return { ...prev, [sid]: cur.filter((item) => item.kind !== "thinking") };
          });
        }, 2500);
      } else {
        delete timers[sid];
      }
      return;
    }

    if (payload.t === "ai_part") {
      const part = payload.part;
      if (part?.type !== "text-delta" || !part.id) return;
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      const timers = thinkTimerRef.current;
      if (timers[sid]) {
        clearTimeout(timers[sid]);
        delete timers[sid];
      }
      const firstDraftForSid = !draftSeenRef.current.has(sid);
      draftSeenRef.current.add(sid);
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        const existing = current.find((message) => isDraftAssistantMessage(message) && message.id === part.id);
        const text = part.reset ? (part.text ?? part.delta ?? "") : `${existing?.text ?? ""}${part.delta ?? ""}`;
        if (!text) return prev;
        const catchUp = existing?.catchUp ?? (firstDraftForSid && !!part.reset && text.length > DRAFT_CATCHUP_MIN_CHARS);
        const message: Message = { id: part.id, role: "assistant", kind: "text", text, ts: part.ts ?? Date.now(), catchUp };
        return { ...prev, [sid]: [...current.filter((item) => item.kind !== "thinking" && item.id !== part.id), message].slice(-80) };
      });
      return;
    }

    if (payload.t === "busy") {
      const busy = !!payload.busy;
      setBusyBySid((prev) => ({ ...prev, [sid]: busy }));
      if (!busy) {
        const tm = thinkTimerRef.current[sid];
        if (tm) {
          clearTimeout(tm);
          delete thinkTimerRef.current[sid];
        }
        setMessagesBySid((prev) => {
          const current = prev[sid];
          if (!current?.some((item) => item.kind === "thinking")) return prev;
          return { ...prev, [sid]: current.filter((item) => item.kind !== "thinking") };
        });
      }
      return;
    }
    if (payload.t === "prompt") setPromptsBySid((prev) => ({ ...prev, [sid]: payload.prompt ?? null }));
    if (payload.t === "queue") setQueuesBySid((prev) => ({ ...prev, [sid]: payload.queue ?? [] }));
  }, [markFirst, send]);

  useEffect(() => {
    if (!enabled) return;
    closedByHookRef.current = false;
    pendingReconnectRef.current = false;

    const noteMessage = () => {
      const now = Date.now();
      if (now - lastMessageFlushRef.current < 2000) return;
      lastMessageFlushRef.current = now;
      setConnection((prev) => ({ ...prev, lastMessageAt: now }));
    };

    const connect = () => {
      if (closedByHookRef.current) return;
      const existing = wsRef.current;
      // A timer fire, a manual retry, and an online/visibility trigger can all
      // race to call connect() around the same moment; never open a second
      // socket on top of one that's already live or in flight.
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      pendingReconnectRef.current = false;
      // Once we've crossed into "offline", a silent background retry attempt
      // shouldn't flash the label back to "reconnecting" only to flip back to
      // "offline" a moment later if it fails again — keep it pinned to
      // "offline" until a connection actually succeeds.
      setConnection((prev) => ({
        ...prev,
        status: prev.status === "offline" ? "offline" : prev.attempt > 0 ? "reconnecting" : "connecting",
      }));
      const ws = new WebSocket(wsUrl("/api/live/ws"));
      wsRef.current = ws;
      openAtRef.current = performance.now();
      firstMsgRef.current = new Set();
      draftSeenRef.current = new Set();
      ws.onopen = () => {
        backoffRef.current = BACKOFF_MIN_MS;
        evlog("ws_client_open", { reconnects: reconnectsRef.current });
        reconnectsRef.current = 0;
        setConnection((prev) => ({ ...prev, status: "live", attempt: 0 }));
        const ids = [...desiredRef.current];
        if (ids.length) {
          ws.send(JSON.stringify({ t: "subscribe", ids }));
          subscribedRef.current = new Set(ids);
        }
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const payload = parseJson<LiveWsMessage>(event.data);
        if (!payload) return;
        noteMessage();
        handleMessage(payload);
      };
      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null;
        subscribedRef.current = new Set();
        if (closedByHookRef.current) return;
        const attempt = (reconnectsRef.current += 1);
        const code = event.code;
        const reason = event.reason || null;
        evlog("ws_client_reconnect", { attempt, backoffMs: backoffRef.current, code, reason });
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        setConnection((prev) => ({
          ...prev,
          status: offline || attempt >= OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting",
          attempt,
          lastCloseCode: code,
          lastCloseReason: reason,
        }));
        // While the tab is hidden, don't keep hammering retries in the
        // background — pause and let the visibilitychange listener below
        // reconnect immediately once the tab is visible again.
        if (typeof document !== "undefined" && document.hidden) {
          pendingReconnectRef.current = true;
          return;
        }
        const delay = jitter(backoffRef.current);
        backoffRef.current = Math.min(BACKOFF_MAX_MS, backoffRef.current * 2);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    };

    connectRef.current = connect;

    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      if (pendingReconnectRef.current) connect();
    };
    const onOnline = () => {
      pendingReconnectRef.current = false;
      connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);

    connect();
    return () => {
      closedByHookRef.current = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      if (reconnectTimerRef.current != null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      pendingReconnectRef.current = false;
      try {
        wsRef.current?.close();
      } catch {}
      wsRef.current = null;
      subscribedRef.current = new Set();
      for (const id of Object.keys(thinkTimerRef.current)) {
        clearTimeout(thinkTimerRef.current[id]);
        delete thinkTimerRef.current[id];
      }
    };
  }, [enabled, handleMessage]);

  const reconnectNow = useCallback(() => {
    pendingReconnectRef.current = false;
    if (reconnectTimerRef.current != null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    backoffRef.current = BACKOFF_MIN_MS;
    connectRef.current();
  }, []);

  useEffect(() => {
    const active = new Set(ids);
    const live = new Set(Object.keys(listBusy));
    desiredRef.current = active;
    seenRef.current = Object.fromEntries(Object.entries(seenRef.current).filter(([sid]) => live.has(sid)));
    setMessagesBySid((prev) => {
      const next: Record<string, Message[]> = {};
      for (const sid of live) {
        const current = prev[sid];
        next[sid] = current?.length ? current : seedBySid[sid] ? [seedBySid[sid]] : [];
      }
      return next;
    });
    setBusyBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))));
    setPromptsBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))));
    setQueuesBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))));
    setNextBeforeBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => live.has(sid))));
    setLoadingBySid((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([sid]) => live.has(sid)));
      for (const sid of active) if (!(messagesRef.current[sid]?.some((message) => !message.seed))) next[sid] = true;
      return next;
    });

    if (!enabled) return;
    const subscribed = subscribedRef.current;
    const toAdd = [...active].filter((sid) => !subscribed.has(sid));
    const toDrop = [...subscribed].filter((sid) => !active.has(sid));
    if (toDrop.length && send({ t: "unsubscribe", ids: toDrop })) {
      for (const sid of toDrop) subscribed.delete(sid);
    }
    if (toAdd.length && send({ t: "subscribe", ids: toAdd })) {
      for (const sid of toAdd) subscribed.add(sid);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey, listBusy, seedBySid, enabled, send]);

  const addOptimisticMessage = useCallback((sid: string, text: string) => {
    const message: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      kind: "text",
      text,
      html: escapeHtml(text).replace(/\n/g, "<br>"),
      ts: Date.now(),
      pending: true,
    };
    setMessagesBySid((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []).filter((item) => item.kind !== "thinking"), message].slice(-80),
    }));
  }, []);

  const removeOptimisticMessage = useCallback((sid: string, text: string) => {
    setMessagesBySid((prev) => {
      const current = prev[sid] ?? [];
      const next = current.filter((item) => !item.pending || !sameMessageNeedle(item.text, text));
      return next.length === current.length ? prev : { ...prev, [sid]: next };
    });
  }, []);

  const refreshMessagesForSid = useCallback(async (
    sid: string,
    text?: string,
    opts: { dropOptimistic?: boolean } = {},
  ) => {
    const page = await api<{ messages: Message[] }>(`/api/sessions/${encodeURIComponent(sid)}/messages?limit=80`);
    const messages = collapseThinkingRuns(Array.isArray(page.messages) ? page.messages : []);
    const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
    for (const message of messages) if (message.id && message.kind !== "thinking") seen.add(message.id);
    if (seen.size > 800) seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
    setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
    setMessagesBySid((prev) => {
      const current = prev[sid] ?? [];
      const pending = current.filter((item) => {
        if (!item.pending) return false;
        if (opts.dropOptimistic && text && sameMessageNeedle(item.text, text)) return false;
        return !messages.some((message) => message.role === "user" && message.kind === "text" && sameMessageNeedle(message.text, item.text));
      });
      return { ...prev, [sid]: [...messages, ...pending].slice(-80) };
    });
    return messages;
  }, []);

  const trackSendStatus = useCallback((sid: string, text: string, initial?: QueueMsg | null) => {
    if (initial) {
      setQueuesBySid((prev) => {
        const current = prev[sid] ?? [];
        const existing = current.find((item) => item.id === initial.id);
        const next = existing ? current.map((item) => (item.id === initial.id ? { ...item, ...initial } : item)) : [...current, initial];
        return { ...prev, [sid]: next };
      });
    }
    void (async () => {
      const targetId = initial?.id;
      for (let attempt = 0; attempt < 45; attempt++) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, attempt < 8 ? 500 : 1200));
        try {
          const page = attempt === 0 || attempt % 3 === 0 ? await refreshMessagesForSid(sid, text) : null;
          if (page?.some((message) => message.role === "user" && message.kind === "text" && sameMessageNeedle(message.text, text))) {
            removeOptimisticMessage(sid, text);
            return;
          }
          const res = await api<{ queue: QueueMsg[] }>(`/api/sessions/${encodeURIComponent(sid)}/queue`);
          const queue = Array.isArray(res.queue) ? res.queue : [];
          setQueuesBySid((prev) => ({ ...prev, [sid]: queue }));
          const item = (targetId ? queue.find((candidate) => candidate.id === targetId) : null) ?? queue.find((candidate) => sameMessageNeedle(candidate.text, text));
          if (!item) {
            await refreshMessagesForSid(sid, text, { dropOptimistic: true }).catch(() => null);
            removeOptimisticMessage(sid, text);
            return;
          }
          if (item.status === "delivered" || item.status === "queued") {
            await refreshMessagesForSid(sid, text, { dropOptimistic: true }).catch(() => null);
            removeOptimisticMessage(sid, text);
            return;
          }
          if (item.status === "failed") return;
        } catch {}
      }
    })();
  }, [refreshMessagesForSid, removeOptimisticMessage]);

  const loadOlderMessages = useCallback<LoadOlderMessages>(async (sid) => {
    if (!(sid in nextBeforeRef.current)) return true;
    const before = nextBeforeRef.current[sid];
    if (before == null) return false;
    const page = await api<{ messages: Message[]; nextBefore: number | null }>(
      `/api/sessions/${encodeURIComponent(sid)}/messages?page=backward&before=${before}&limit=80`,
    );
    const older = collapseThinkingRuns(Array.isArray(page.messages) ? page.messages : []);
    setNextBeforeBySid((prev) => ({ ...prev, [sid]: page.nextBefore ?? null }));
    if (!older.length) return (page.nextBefore ?? null) !== null;
    const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
    for (const message of older) if (message.id && message.kind !== "thinking") seen.add(message.id);
    setMessagesBySid((prev) => {
      const current = prev[sid] ?? [];
      const existing = new Set(current.map((message) => message.id).filter(Boolean));
      const prepend = older.filter((message) => !message.id || !existing.has(message.id));
      if (!prepend.length) return prev;
      return { ...prev, [sid]: [...prepend, ...current.filter((message) => !message.seed)] };
    });
    return (page.nextBefore ?? null) !== null;
  }, []);

  const mergedBusy = useMemo(() => ({ ...listBusy, ...busyBySid }), [listBusy, busyBySid]);

  return {
    messagesBySid,
    busyBySid: mergedBusy,
    promptsBySid,
    queuesBySid,
    loadingBySid,
    addOptimisticMessage,
    removeOptimisticMessage,
    trackSendStatus,
    loadOlderMessages,
    connection,
    reconnectNow,
  };
}
