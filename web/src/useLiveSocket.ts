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

export type Message = {
  id?: string;
  role?: string;
  kind?: string;
  text?: string;
  html?: string;
  ts?: number;
  url?: string;
  artifactId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  caption?: string;
  alt?: string;
  version?: number;
  title?: string;
  pending?: boolean;
  seed?: boolean;
  catchUp?: boolean;
};

export type AiStreamPart = {
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
type ChannelKind = "transcript" | "status" | "agent_run" | "summary" | "resumable";
type LiveChannel = { kind: ChannelKind; key: string; resumeFromSeq?: number };
type AgentRunSnapshot = {
  id: string;
  agent: string;
  date?: string;
  status: "running" | "done" | "failed";
  logs: string[];
  result?: unknown;
  error?: string;
};
type AgentRunEvent =
  | { type: "log"; line: string }
  | { type: "done" | "failed"; status: "done" | "failed"; result?: unknown; error?: string };

type LiveWsMessage =
  | { t: "batch"; sid: string; messages?: Message[]; nextBefore?: number | null }
  | { t: "msg"; sid: string; message?: Message; m?: Message }
  | { t: "ai_part"; sid: string; part?: AiStreamPart }
  | { t: "busy"; sid: string; busy?: boolean }
  | { t: "prompt"; sid: string; prompt?: SessionPrompt | null }
  | { t: "queue"; sid: string; queue?: QueueMsg[] }
  | { t: "page"; sid: string; messages?: Message[]; nextBefore?: number | null; hasMore?: boolean }
  | { t: "snapshot"; kind: ChannelKind; key: string; sid?: string; seq?: number; messages?: Message[]; nextBefore?: number | null; run?: AgentRunSnapshot; text?: string; done?: boolean; error?: string | null }
  | { t: "delta"; kind: ChannelKind; key: string; seq?: number; delta?: { t?: string; sid?: string; message?: Message; m?: Message; part?: AiStreamPart; busy?: boolean; prompt?: SessionPrompt | null; queue?: QueueMsg[]; event?: AgentRunEvent; chunk?: string; done?: boolean; error?: string | null } }
  | { t: "resumed"; kind: ChannelKind; key: string; seq?: number; fromSeq?: number; toSeq?: number; replayed?: number }
  | { t: "gap"; kind: ChannelKind; key: string; seq?: number }
  | { t: "status"; rows?: StatusRow[]; kind?: ChannelKind; key?: string; seq?: number }
  | { t: "ping"; id?: string }
  | { t: "pong"; id?: string }
  | { t: "error"; sid?: string; kind?: ChannelKind; key?: string; seq?: number; message?: string; code?: string };

type AgentRunHandler = {
  onSnapshot?: (run: AgentRunSnapshot) => void;
  onEvent?: (event: AgentRunEvent) => void;
  onError?: (message: string) => void;
};
type SummaryHandler = {
  delivered: number;
  full: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  onChunk: (chunk: string) => void;
};
export type TranscriptEvent =
  | { type: "message"; message: Message }
  | { type: "ai_part"; part: AiStreamPart }
  | { type: "busy"; busy: boolean }
  | { type: "error"; error: string };
export type TranscriptSubscribe = (
  sid: string,
  listener: (event: TranscriptEvent) => void,
) => () => void;

const DRAFT_CATCHUP_MIN_CHARS = 160;

declare global {
  interface Window {
    __LFG_CONFIG__?: { liveTransport?: string };
  }
}

export function liveTransportMode(): "sse" | "ws" {
  const runtime = typeof window !== "undefined" ? window.__LFG_CONFIG__?.liveTransport : undefined;
  const build = import.meta.env.VITE_LIVE_TRANSPORT;
  return runtime === "sse" || build === "sse" ? "sse" : "ws";
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

function channelId(channel: Pick<LiveChannel, "kind" | "key">): string {
  return `${channel.kind}:${channel.key}`;
}

function transcriptChannel(sid: string): LiveChannel {
  return { kind: "transcript", key: sid };
}

function artifactIdFromUrl(url?: string): string | null {
  if (!url) return null;
  const match = url.match(/\/api\/artifacts\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function mediaIdentity(message: Message): string | null {
  if (message.kind !== "image" && message.kind !== "video") return message.id ?? null;
  const artifactId = message.artifactId || artifactIdFromUrl(message.url);
  if (artifactId) return `artifact-${artifactId}`;
  if (message.url) return `media-${message.kind}-${message.url}`;
  if (message.id) return message.id;
  return `media-${message.kind}-${message.ts ?? "no-ts"}-${message.name ?? ""}-${message.size ?? ""}-${message.text ?? ""}`;
}

function normalizeMessageIdentity(message: Message): Message {
  const id = mediaIdentity(message);
  if (!id || id === message.id) return message;
  return { ...message, id };
}

function normalizeMessageList(messages: Message[]): Message[] {
  return messages.map(normalizeMessageIdentity);
}

// Media order is owned by the server transcript index (joined artifact rows).
// Live upserts must keep an existing card's position and append brand-new media
// at the tail — never re-sort by timestamp, which put images out of place when
// a second poll stream raced the ordered transcript.
function upsertMessageById(current: Message[], message: Message): Message[] {
  const normalized = normalizeMessageIdentity(message);
  const id = mediaIdentity(normalized);
  if (!id || normalized.kind === "thinking") return [...current.filter((item) => item.kind !== "thinking"), normalized];
  const existingIndex = current.findIndex((item) => mediaIdentity(item) === id);
  const withoutTransient = current.filter((item, index) => {
    if (index === existingIndex) return false;
    if (item.kind === "thinking") return false;
    if (normalized.role === "user" && normalized.kind === "text") {
      return !item.pending || !sameMessageNeedle(normalized.text, item.text);
    }
    if (normalized.role === "assistant" && normalized.kind === "text" && isDraftAssistantMessage(item)) return false;
    return true;
  });
  if (existingIndex >= 0) {
    const insertAt = Math.min(existingIndex, withoutTransient.length);
    return [...withoutTransient.slice(0, insertAt), normalized, ...withoutTransient.slice(insertAt)];
  }
  return [...withoutTransient, normalized];
}

function reconcileSnapshotMessages(current: Message[], incoming: Message[]): Message[] {
  const authoritative = collapseThinkingRuns(normalizeMessageList(incoming));
  const next = authoritative.filter((message) => !message.seed);
  const incomingIds = new Set(next.map(mediaIdentity).filter(Boolean));
  const incomingUserText = next.filter((message) => message.role === "user" && message.kind === "text");
  const latestIncomingTs = next.reduce((max, message) => Math.max(max, message.ts ?? 0), 0);
  for (const local of current) {
    const normalized = normalizeMessageIdentity(local);
    if (normalized.seed || normalized.kind === "thinking") continue;
    const id = mediaIdentity(normalized);
    if (id && incomingIds.has(id)) continue;
    if (
      normalized.pending &&
      incomingUserText.some((message) => sameMessageNeedle(message.text, normalized.text))
    ) {
      continue;
    }
    const localTs = normalized.ts ?? (normalized.pending ? Date.now() : 0);
    if (normalized.pending || !latestIncomingTs || localTs >= latestIncomingTs) next.push(normalized);
  }
  return collapseThinkingRuns(next).slice(-80);
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
  latencyMs: number | null;
};

const INITIAL_CONNECTION_STATE: ConnectionState = {
  status: "connecting",
  attempt: 0,
  lastCloseCode: null,
  lastCloseReason: null,
  lastMessageAt: null,
  latencyMs: null,
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
  const [loadingBySid, setLoadingBySid] = useState<Record<string, boolean>>({});
  const [nextBeforeBySid, setNextBeforeBySid] = useState<Record<string, number | null>>({});

  const wsRef = useRef<WebSocket | null>(null);
  const desiredRef = useRef<Set<string>>(new Set());
  const subscribedRef = useRef<Set<string>>(new Set());
  const desiredChannelsRef = useRef<Map<string, LiveChannel>>(new Map());
  const subscribedChannelsRef = useRef<Set<string>>(new Set());
  const activeTranscriptIdsRef = useRef<Set<string>>(new Set());
  const lastSeqRef = useRef<Record<string, number>>({});
  const agentRunHandlersRef = useRef<Record<string, AgentRunHandler>>({});
  const summaryHandlersRef = useRef<Record<string, SummaryHandler>>({});
  const transcriptListenersRef = useRef<Record<string, Set<(event: TranscriptEvent) => void>>>({});
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
  const latencyProbeRef = useRef<{ id: string; startedAt: number } | null>(null);
  const connectRef = useRef<() => void>(() => {});

  const [connection, setConnection] = useState<ConnectionState>(INITIAL_CONNECTION_STATE);

  const emitTranscriptEvent = useCallback((sid: string, event: TranscriptEvent) => {
    const listeners = transcriptListenersRef.current[sid];
    if (!listeners?.size) return;
    for (const listener of listeners) listener(event);
  }, []);

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

  const channelWithResume = useCallback((channel: LiveChannel): LiveChannel => {
    const seq = lastSeqRef.current[channelId(channel)];
    return seq ? { ...channel, resumeFromSeq: seq } : channel;
  }, []);

  const subscribeChannels = useCallback((channels: LiveChannel[]) => {
    if (!channels.length) return false;
    return send({ t: "subscribe", channels: channels.map(channelWithResume) });
  }, [channelWithResume, send]);

  const unsubscribeChannels = useCallback((channels: LiveChannel[]) => {
    if (!channels.length) return false;
    // Drop the resume cursor with the subscription. The cursor is a promise
    // that we still hold every frame up to that seq — but the app deletes a
    // session's local message state when it leaves the live set, so resuming
    // from the old seq on re-entry would replay only new deltas and render a
    // history-less chat. Without a cursor the next subscribe gets a snapshot.
    for (const channel of channels) delete lastSeqRef.current[channelId(channel)];
    return send({ t: "unsubscribe", channels });
  }, [send]);

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
      send({ t: "pong", ...(payload.id ? { id: payload.id } : {}) });
      return;
    }
    if (payload.t === "pong") {
      const probe = latencyProbeRef.current;
      if (!payload.id || !probe || payload.id !== probe.id) return;
      latencyProbeRef.current = null;
      const latencyMs = Math.max(1, Math.round(performance.now() - probe.startedAt));
      setConnection((prev) => ({ ...prev, latencyMs }));
      return;
    }
    if ("kind" in payload && payload.kind && "key" in payload && typeof payload.key === "string") {
      const cid = channelId({ kind: payload.kind, key: payload.key });
      if (typeof payload.seq === "number" && Number.isFinite(payload.seq)) {
        const previous = lastSeqRef.current[cid] ?? 0;
        // `snapshot`/`gap`/`resumed` are authoritative resync points: the server
        // sends them precisely when our resume cursor is invalid (e.g. its seq
        // counters reset on restart, so every new frame is numerically "stale").
        // Dropping them by seq comparison would permanently blind a long-lived
        // page after a serve restart — accept them and rebase the cursor instead.
        const resync = payload.t === "snapshot" || payload.t === "gap" || payload.t === "resumed";
        if (!resync && payload.seq <= previous) return;
        lastSeqRef.current[cid] = payload.seq;
      }
      if (payload.t === "error") {
        const message = payload.message || payload.code || "live socket error";
        if (payload.kind === "transcript") emitTranscriptEvent(payload.key, { type: "error", error: message });
        if (payload.kind === "agent_run") agentRunHandlersRef.current[payload.key]?.onError?.(message);
        if (payload.kind === "summary") {
          const handler = summaryHandlersRef.current[payload.key];
          if (handler) {
            handler.reject(new Error(message));
            delete summaryHandlersRef.current[payload.key];
          }
        }
        return;
      }
      if (payload.t === "gap" || payload.t === "resumed") return;
      if (payload.t === "snapshot") {
        if (payload.kind === "transcript") {
          handleMessage({
            t: "batch",
            sid: payload.sid ?? payload.key,
            messages: payload.messages,
            nextBefore: payload.nextBefore,
          });
          return;
        }
        if (payload.kind === "agent_run" && payload.run) {
          agentRunHandlersRef.current[payload.key]?.onSnapshot?.(payload.run);
          return;
        }
        if (payload.kind === "summary") {
          const handler = summaryHandlersRef.current[payload.key];
          if (!handler) return;
          const text = payload.text ?? "";
          handler.full = text;
          if (text.length > handler.delivered) {
            handler.onChunk(text.slice(handler.delivered));
            handler.delivered = text.length;
          }
          if (payload.error) {
            handler.reject(new Error(payload.error));
            delete summaryHandlersRef.current[payload.key];
          } else if (payload.done) {
            handler.resolve(handler.full);
            delete summaryHandlersRef.current[payload.key];
          }
          return;
        }
      }
      if (payload.t === "delta") {
        const delta = payload.delta;
        if (!delta) return;
        if (payload.kind === "transcript" && delta.t) {
          handleMessage({ ...delta, t: delta.t, sid: delta.sid ?? payload.key } as LiveWsMessage);
          return;
        }
        if (payload.kind === "agent_run" && delta.event) {
          agentRunHandlersRef.current[payload.key]?.onEvent?.(delta.event);
          return;
        }
        if (payload.kind === "summary") {
          const handler = summaryHandlersRef.current[payload.key];
          if (!handler) return;
          if (delta.chunk) {
            handler.full += delta.chunk;
            handler.delivered += delta.chunk.length;
            handler.onChunk(delta.chunk);
          }
          if (delta.error) {
            handler.reject(new Error(delta.error));
            delete summaryHandlersRef.current[payload.key];
          } else if (delta.done) {
            handler.resolve(handler.full);
            delete summaryHandlersRef.current[payload.key];
          }
          return;
        }
      }
    }
    if (payload.t === "status") {
      if (Array.isArray(payload.rows)) onStatusRowsRef.current?.(payload.rows);
      return;
    }
    if (payload.t === "error") return;
    const sid = "sid" in payload ? payload.sid : undefined;
    if (!sid || !desiredRef.current.has(sid)) return;

    if (payload.t === "batch") {
      const messages = collapseThinkingRuns(normalizeMessageList(Array.isArray(payload.messages) ? payload.messages : []));
      if (messages.length) markFirst(sid, messages[0], true, messages.length);
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
      for (const message of messages) {
        const id = mediaIdentity(message);
        if (id && message.kind !== "thinking") seen.add(id);
      }
      if (seen.size > 800) seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
      setNextBeforeBySid((prev) => ({ ...prev, [sid]: payload.nextBefore ?? null }));
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        return { ...prev, [sid]: reconcileSnapshotMessages(current, messages) };
      });
      return;
    }

    if (payload.t === "msg") {
      const rawMessage = payload.message ?? payload.m;
      if (!rawMessage) return;
      const message = normalizeMessageIdentity(rawMessage);
      emitTranscriptEvent(sid, { type: "message", message });
      markFirst(sid, message);
      setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
      const id = mediaIdentity(message);
      if (id && message.kind !== "thinking") {
        const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
        seen.add(id);
        if (seen.size > 800) seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
      }
      setMessagesBySid((prev) => {
        const current = prev[sid] ?? [];
        const next = upsertMessageById(current, message);
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
      if (part) emitTranscriptEvent(sid, { type: "ai_part", part });
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
      emitTranscriptEvent(sid, { type: "busy", busy });
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
    // queue events are intentionally ignored — send status is polled by
    // trackSendStatus for optimistic-bubble reconciliation; no composer chip.
  }, [emitTranscriptEvent, markFirst, send]);

  useEffect(() => {
    if (!enabled) return;
    closedByHookRef.current = false;
    pendingReconnectRef.current = false;

    const probeLatency = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const id = crypto.randomUUID?.() ?? `ping-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      latencyProbeRef.current = { id, startedAt: performance.now() };
      ws.send(JSON.stringify({ t: "ping", id }));
    };
    const latencyTimer = window.setInterval(probeLatency, 5_000);

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
        probeLatency();
        const channels = [...desiredChannelsRef.current.values()];
        if (channels.length) {
          ws.send(JSON.stringify({ t: "subscribe", channels: channels.map(channelWithResume) }));
          subscribedChannelsRef.current = new Set(channels.map(channelId));
          subscribedRef.current = new Set(channels.filter((channel) => channel.kind === "transcript").map((channel) => channel.key));
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
        subscribedChannelsRef.current = new Set();
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
          latencyMs: null,
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
      window.clearInterval(latencyTimer);
      latencyProbeRef.current = null;
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
      subscribedChannelsRef.current = new Set();
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
    const expanded = new Set(ids);
    activeTranscriptIdsRef.current = expanded;
    const active = new Set([...expanded, ...Object.keys(transcriptListenersRef.current)]);
    const live = new Set(Object.keys(listBusy));
    const previousActive = desiredRef.current;
    desiredRef.current = active;
    seenRef.current = Object.fromEntries(Object.entries(seenRef.current).filter(([sid]) => live.has(sid)));
    setMessagesBySid((prev) => {
      const next: Record<string, Message[]> = {};
      // Retain message state for every sid we are (or stay) subscribed to —
      // not just busy ones. The subscription resumes by seq cursor, so the
      // server never re-sends a snapshot while we're subscribed; dropping a
      // still-subscribed idle session's messages here left re-entered chats
      // rendering only the deltas that arrived after the drop.
      for (const sid of new Set([...live, ...active])) {
        const current = prev[sid];
        next[sid] = current?.length ? current : seedBySid[sid] ? [seedBySid[sid]] : [];
      }
      return next;
    });
    setBusyBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))));
    setPromptsBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => active.has(sid))));
    setNextBeforeBySid((prev) => Object.fromEntries(Object.entries(prev).filter(([sid]) => live.has(sid) || active.has(sid))));
    setLoadingBySid((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([sid]) => live.has(sid)));
      for (const sid of expanded) {
        if (!previousActive.has(sid) && !(messagesRef.current[sid]?.some((message) => !message.seed))) {
          next[sid] = true;
        }
      }
      return next;
    });

    const nextDesired = new Map(desiredChannelsRef.current);
    for (const [id, channel] of nextDesired) {
      if (channel.kind === "transcript") nextDesired.delete(id);
    }
    for (const sid of active) {
      const channel = transcriptChannel(sid);
      nextDesired.set(channelId(channel), channel);
    }
    desiredChannelsRef.current = nextDesired;

    if (!enabled) return;
    const subscribed = subscribedChannelsRef.current;
    const desiredTranscriptIds = new Set([...active].map((sid) => channelId(transcriptChannel(sid))));
    const toAdd = [...active]
      .map(transcriptChannel)
      .filter((channel) => !subscribed.has(channelId(channel)));
    const toDrop = [...subscribed]
      .map((id) => desiredChannelsRef.current.get(id) ?? (id.startsWith("transcript:") ? { kind: "transcript" as const, key: id.slice("transcript:".length) } : null))
      .filter((channel): channel is LiveChannel => !!channel && channel.kind === "transcript" && !desiredTranscriptIds.has(channelId(channel)));
    if (toDrop.length && unsubscribeChannels(toDrop)) {
      for (const channel of toDrop) {
        subscribed.delete(channelId(channel));
        subscribedRef.current.delete(channel.key);
      }
    }
    if (toAdd.length && subscribeChannels(toAdd)) {
      for (const channel of toAdd) {
        subscribed.add(channelId(channel));
        subscribedRef.current.add(channel.key);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey, listBusy, seedBySid, enabled, subscribeChannels, unsubscribeChannels]);

  useEffect(() => {
    if (!ids.length) return;
    const active = new Set(ids);
    const timeout = window.setTimeout(() => {
      evlog("ws_client_loading_fallback", { ids });
      setLoadingBySid((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const sid of active) {
          if (next[sid] && !(messagesRef.current[sid]?.some((message) => !message.seed))) {
            next[sid] = false;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [streamKey, ids]);

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
    setBusyBySid((prev) => ({ ...prev, [sid]: true }));
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
    const messages = collapseThinkingRuns(normalizeMessageList(Array.isArray(page.messages) ? page.messages : []));
    const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
    for (const message of messages) {
      const id = mediaIdentity(message);
      if (id && message.kind !== "thinking") seen.add(id);
    }
    if (seen.size > 800) seenRef.current[sid] = new Set(Array.from(seen).slice(-400));
    setLoadingBySid((prev) => ({ ...prev, [sid]: false }));
    setMessagesBySid((prev) => {
      const current = prev[sid] ?? [];
      const reconciled = reconcileSnapshotMessages(current, messages);
      if (!opts.dropOptimistic || !text) return { ...prev, [sid]: reconciled };
      return {
        ...prev,
        [sid]: reconciled.filter((item) => !item.pending || !sameMessageNeedle(item.text, text)),
      };
    });
    return messages;
  }, []);

  const trackSendStatus = useCallback((sid: string, text: string, initial?: QueueMsg | null) => {
    // Poll until the optimistic bubble can be reconciled with the transcript
    // or the server queue reports the message as accepted/failed. No separate
    // "sending" chip — the chat bubble is the in-flight UI.
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
    const older = collapseThinkingRuns(normalizeMessageList(Array.isArray(page.messages) ? page.messages : []));
    setNextBeforeBySid((prev) => ({ ...prev, [sid]: page.nextBefore ?? null }));
    if (!older.length) return (page.nextBefore ?? null) !== null;
    const seen = seenRef.current[sid] || (seenRef.current[sid] = new Set());
    for (const message of older) {
      const id = mediaIdentity(message);
      if (id && message.kind !== "thinking") seen.add(id);
    }
    setMessagesBySid((prev) => {
      const current = prev[sid] ?? [];
      const existing = new Set(current.map(mediaIdentity).filter(Boolean));
      const prepend = older.filter((message) => {
        const id = mediaIdentity(message);
        return !id || !existing.has(id);
      });
      if (!prepend.length) return prev;
      return { ...prev, [sid]: [...prepend, ...current.filter((message) => !message.seed)] };
    });
    return (page.nextBefore ?? null) !== null;
  }, []);

  const watchAgentRun = useCallback((runId: string, handler: AgentRunHandler) => {
    const channel: LiveChannel = { kind: "agent_run", key: runId };
    const id = channelId(channel);
    agentRunHandlersRef.current[runId] = handler;
    desiredChannelsRef.current.set(id, channel);
    if (enabled && subscribeChannels([channel])) subscribedChannelsRef.current.add(id);
    return () => {
      delete agentRunHandlersRef.current[runId];
      desiredChannelsRef.current.delete(id);
      if (enabled && unsubscribeChannels([channel])) subscribedChannelsRef.current.delete(id);
    };
  }, [enabled, subscribeChannels, unsubscribeChannels]);

  const streamSummary = useCallback((sid: string, onChunk: (chunk: string) => void) => {
    const channel: LiveChannel = { kind: "summary", key: sid };
    const id = channelId(channel);
    delete lastSeqRef.current[id];
    desiredChannelsRef.current.set(id, channel);
    const cleanup = () => {
      delete summaryHandlersRef.current[sid];
      desiredChannelsRef.current.delete(id);
      if (enabled && unsubscribeChannels([channel])) subscribedChannelsRef.current.delete(id);
    };
    const promise = new Promise<string>((resolve, reject) => {
      summaryHandlersRef.current[sid] = {
        delivered: 0,
        full: "",
        onChunk,
        resolve: (text) => {
          cleanup();
          resolve(text);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
    if (enabled && subscribeChannels([channel])) subscribedChannelsRef.current.add(id);
    return promise;
  }, [enabled, subscribeChannels, unsubscribeChannels]);

  const subscribeTranscript = useCallback<TranscriptSubscribe>((sid, listener) => {
    const listeners = transcriptListenersRef.current[sid] || (transcriptListenersRef.current[sid] = new Set());
    listeners.add(listener);
    const channel = transcriptChannel(sid);
    const id = channelId(channel);
    desiredRef.current.add(sid);
    desiredChannelsRef.current.set(id, channel);
    if (enabled && !subscribedChannelsRef.current.has(id) && subscribeChannels([channel])) {
      subscribedChannelsRef.current.add(id);
      subscribedRef.current.add(sid);
    }
    return () => {
      const current = transcriptListenersRef.current[sid];
      if (!current) return;
      current.delete(listener);
      if (current.size) return;
      delete transcriptListenersRef.current[sid];
      if (activeTranscriptIdsRef.current.has(sid)) return;
      desiredRef.current.delete(sid);
      desiredChannelsRef.current.delete(id);
      if (enabled && subscribedChannelsRef.current.has(id) && unsubscribeChannels([channel])) {
        subscribedChannelsRef.current.delete(id);
        subscribedRef.current.delete(sid);
      }
    };
  }, [enabled, subscribeChannels, unsubscribeChannels]);

  const mergedBusy = useMemo(() => ({ ...listBusy, ...busyBySid }), [listBusy, busyBySid]);

  return {
    messagesBySid,
    busyBySid: mergedBusy,
    promptsBySid,
    loadingBySid,
    addOptimisticMessage,
    removeOptimisticMessage,
    trackSendStatus,
    loadOlderMessages,
    connection,
    reconnectNow,
    watchAgentRun,
    streamSummary,
    subscribeTranscript,
  };
}
