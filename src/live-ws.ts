import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import type { ServerWebSocket } from "bun";
import { PATHS } from "./config.ts";
import {
  listSessions,
  resolveTranscript,
  recentMessagesCached,
  messagePage,
  normalizeLineMessages,
  pendingToolPrompt,
  type PendingPrompt,
  type Session,
} from "./sessions.ts";
import { enqueueTranscriptIndex, indexedMessagePage } from "./transcript-index.ts";
import {
  capturePane,
  parsePrompt,
  isBusy,
  type PanePrompt,
} from "./tmux.ts";
import {
  findEntryByAnyId,
  isEntryBusy as isAisdkEntryBusy,
} from "./aisdk-registry.ts";
import { imageArtifactMessagesSince, imageArtifactToMessage, listImageArtifacts, type ImageArtifactMessage } from "./artifacts.ts";
import { listQueue, reconcileQueued } from "./sendq.ts";

export type LiveWsSocketData = { liveWs: true; rid: string };

type Evlog = (event: string, fields?: Record<string, unknown>) => void;
type LiveWs = ServerWebSocket<unknown>;
type SendType = "batch" | "msg" | "page" | "busy" | "prompt" | "queue" | "ai_part" | "error";
type DraftState = { id: string; text: string };
type HtmlMessage = { kind: string; text: string; html?: string; id?: string | null; ts?: number | null };
type LivePane = { sid: string; tp: string | null; target: string | null };

const EVLOG_DIR = join(PATHS.data, "evlogs");
const SID_RE = /^[0-9a-fA-F-]{36}$/;
const SUBSCRIPTION_CAP = 48;
const BACKLOG_LIMIT = 40;
const HEARTBEAT_MS = 25_000;
const IDLE_CLOSE_MS = 60_000;

const messageHtmlCache = new Map<string, string>();
const MESSAGE_HTML_CACHE_MAX = 4_000;

function defaultEvlog(event: string, fields: Record<string, unknown> = {}) {
  try {
    mkdirSync(EVLOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(
      join(EVLOG_DIR, `${day}.jsonl`),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        monoMs: Math.round(performance.now() * 1000) / 1000,
        event,
        ...fields,
      })}\n`,
    );
  } catch {}
}

export function liveTransportMode(): "sse" | "ws" {
  return process.env.LIVE_TRANSPORT === "ws" ? "ws" : "sse";
}

export function isLiveWsEnabled(): boolean {
  return liveTransportMode() === "ws";
}

export function liveWsUpgradeAuthenticated(_req: Request): boolean {
  // The existing local API and live SSE endpoints are unauthenticated; matching
  // that behavior here means there is no additional credential to validate.
  return true;
}

function safeSend(ws: LiveWs, payload: unknown): boolean {
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function messageHtmlCacheKey(m: HtmlMessage): string {
  return `${m.id ?? ""}\0${m.kind}\0${m.text.length}\0${m.text.slice(0, 96)}`;
}

function rememberMessageHtml(key: string, html: string) {
  if (messageHtmlCache.has(key)) messageHtmlCache.delete(key);
  messageHtmlCache.set(key, html);
  if (messageHtmlCache.size <= MESSAGE_HTML_CACHE_MAX) return;
  const oldest = messageHtmlCache.keys().next().value;
  if (oldest) messageHtmlCache.delete(oldest);
}

function msgWithHtml<T extends HtmlMessage>(m: T): T & { html?: string } {
  if (m.kind === "text" && m.text) {
    const key = messageHtmlCacheKey(m);
    const cached = messageHtmlCache.get(key);
    if (cached !== undefined) return { ...m, html: cached };
    const html = marked.parse(m.text) as string;
    rememberMessageHtml(key, html);
    return { ...m, html };
  }
  return m;
}

function visibleTranscriptMessages<T extends { kind: string }>(messages: T[]): T[] {
  return messages.filter((message) => message.kind !== "tool_result");
}

function withImageArtifacts<T extends { text: string; ts?: number | null; id?: string | null }>(
  sessionId: string,
  messages: T[],
): Array<T | ImageArtifactMessage> {
  const artifacts = listImageArtifacts(sessionId).map(imageArtifactToMessage);
  if (!artifacts.length) return messages;
  const seen = new Set(messages.map((message) => message.id).filter(Boolean));
  return [...messages, ...artifacts.filter((artifact) => !seen.has(artifact.id))]
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

function transcriptMessagesForClient<T extends { kind: string; text: string; ts?: number | null; id?: string | null }>(
  sessionId: string,
  messages: T[],
): Array<T | ImageArtifactMessage> {
  return withImageArtifacts(sessionId, visibleTranscriptMessages(messages));
}

async function resolveSessionPrompt(
  tp: string | null,
  pane: string | null,
): Promise<PanePrompt | PendingPrompt | null> {
  if (tp) {
    const pending = await pendingToolPrompt(tp);
    if (pending) return pending;
  }
  return pane ? parsePrompt(pane) : null;
}

function sendAiTextDeltaPart(
  emit: (type: SendType, fields: Record<string, unknown>) => void,
  sid: string,
  entry: { sessionId: string; draftText?: string | null; draftUpdatedAt?: number | null },
  lastDraft: Map<string, DraftState>,
): void {
  const id = `draft-${entry.sessionId}`;
  const text = entry.draftText ?? "";
  const prev = lastDraft.get(sid);
  if (!text) {
    if (prev) lastDraft.delete(sid);
    return;
  }
  let part: { type: "text-delta"; id: string; delta?: string; text?: string; reset?: boolean; ts: number };
  if (!prev || prev.id !== id || !text.startsWith(prev.text)) {
    part = { type: "text-delta", id, text, reset: true, ts: entry.draftUpdatedAt ?? Date.now() };
  } else {
    const delta = text.slice(prev.text.length);
    if (!delta) return;
    part = { type: "text-delta", id, delta, ts: entry.draftUpdatedAt ?? Date.now() };
  }
  lastDraft.set(sid, { id, text });
  emit("ai_part", { part });
}

function slimStatus(s: Session) {
  return {
    sessionId: s.sessionId,
    busy: !!s.busy,
    title: s.title ?? null,
    lastUserText: s.lastUserText ?? null,
    lastActivityAt: s.lastActivityAt ?? null,
    status: s.status ?? "ok",
    statusReason: s.statusReason ?? null,
    statusDetail: s.statusDetail ?? null,
    model: s.model ?? null,
  };
}

type SocketState = {
  ws: LiveWs;
  rid: string;
  subscribed: Set<string>;
  seqBySid: Map<string, number>;
  closed: boolean;
  lastTraffic: number;
  heartbeat: ReturnType<typeof setInterval> | null;
};

type SidTail = {
  sid: string;
  sockets: Set<LiveWs>;
  pane: LivePane;
  offset: number;
  buf: string;
  lastSig: string;
  lastBusy: string;
  lastQ: string;
  lastArtifactAt: number;
  lastDraft: Map<string, DraftState>;
  pumpInterval: ReturnType<typeof setInterval> | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  draftInterval: ReturnType<typeof setInterval> | null;
};

export function createLiveWsSupport(opts: { evlog?: Evlog } = {}) {
  const evlog = opts.evlog ?? defaultEvlog;
  const sockets = new WeakMap<LiveWs, SocketState>();
  const sidTails = new Map<string, SidTail>();
  const openSockets = new Set<LiveWs>();
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let lastStatusSig = "";
  let statusPublishing = false;

  const nextSeq = (state: SocketState, sid: string): number => {
    const next = (state.seqBySid.get(sid) ?? 0) + 1;
    state.seqBySid.set(sid, next);
    return next;
  };

  const sendSid = (state: SocketState, type: SendType, sid: string, fields: Record<string, unknown>) => {
    if (state.closed || !state.subscribed.has(sid)) return;
    safeSend(state.ws, { t: type, sid, seq: nextSeq(state, sid), ...fields });
  };

  const publishSid = (sid: string, type: SendType, fields: Record<string, unknown>) => {
    const tail = sidTails.get(sid);
    if (!tail) return;
    for (const ws of tail.sockets) {
      const state = sockets.get(ws);
      if (state) sendSid(state, type, sid, fields);
    }
  };

  const stopStatusLoopIfIdle = () => {
    if (openSockets.size || !statusInterval) return;
    clearInterval(statusInterval);
    statusInterval = null;
    lastStatusSig = "";
  };

  const publishStatus = async () => {
    if (!openSockets.size) return;
    if (statusPublishing) return;
    statusPublishing = true;
    const t0 = performance.now();
    try {
      const rows = (await listSessions())
        .filter((s) => s.sessionId)
        .map(slimStatus);
      const sig = JSON.stringify(rows);
      const changed = sig !== lastStatusSig;
      if (changed) {
        lastStatusSig = sig;
        for (const ws of openSockets) safeSend(ws, { t: "status", rows });
      }
      evlog("live_status_tick", {
        transport: "ws",
        sessions: rows.length,
        changed,
        durationMs: roundMs(performance.now() - t0),
      });
    } finally {
      statusPublishing = false;
    }
  };

  const ensureStatusLoop = () => {
    if (statusInterval) return;
    void publishStatus();
    statusInterval = setInterval(() => void publishStatus(), 1000);
  };

  const cleanupSidTail = (sid: string) => {
    const tail = sidTails.get(sid);
    if (!tail || tail.sockets.size) return;
    if (tail.pumpInterval) clearInterval(tail.pumpInterval);
    if (tail.pollInterval) clearInterval(tail.pollInterval);
    if (tail.draftInterval) clearInterval(tail.draftInterval);
    sidTails.delete(sid);
  };

  const hydrateTarget = async (tail: SidTail) => {
    const all = await listSessions();
    const bySid = new Map(all.map((s) => [s.sessionId, s.tmuxTarget ?? null]));
    tail.pane.target = bySid.get(tail.sid) ?? null;
  };

  const pumpOne = async (tail: SidTail) => {
    try {
      if (!tail.pane.tp) {
        const tp = await resolveTranscript(tail.sid);
        if (!tp) return;
        tail.pane.tp = tp;
        enqueueTranscriptIndex(tp, tail.sid);
        await publishCurrentBatch(tail);
        tail.offset = Bun.file(tp).size;
        return;
      }
      const pumpT0 = performance.now();
      const f = Bun.file(tail.pane.tp);
      const size = f.size;
      if (size < tail.offset) tail.offset = 0;
      if (size <= tail.offset) return;
      const bytes = size - tail.offset;
      const chunk = await f.slice(tail.offset, size).text();
      tail.offset = size;
      tail.buf += chunk;
      const lines = tail.buf.split("\n");
      tail.buf = lines.pop() ?? "";
      let visibleLines = 0;
      for (const line of lines) {
        if (!line) continue;
        visibleLines++;
        const messages = visibleTranscriptMessages(normalizeLineMessages(line));
        for (const message of messages) {
          publishSid(tail.sid, "msg", { message: msgWithHtml(message) });
        }
      }
      evlog("ws_msg_pump", {
        sid: tail.sid,
        bytes,
        lines: visibleLines,
        subscribers: tail.sockets.size,
        durationMs: roundMs(performance.now() - pumpT0),
      });
    } catch {}
  };

  const pollArtifacts = (tail: SidTail) => {
    const messages = imageArtifactMessagesSince(tail.sid, tail.lastArtifactAt);
    for (const message of messages) {
      tail.lastArtifactAt = Math.max(tail.lastArtifactAt, message.ts ?? 0);
      publishSid(tail.sid, "msg", { message: msgWithHtml(message) });
    }
  };

  const pollQueue = (tail: SidTail) => {
    const queue = listQueue(tail.sid);
    const sig = JSON.stringify(queue);
    if (sig === tail.lastQ) return;
    tail.lastQ = sig;
    publishSid(tail.sid, "queue", { queue });
  };

  const pollOne = async (tail: SidTail) => {
    if (!tail.pane.target) {
      const entry = findEntryByAnyId(tail.sid);
      if (!entry) return;
      const busy = isAisdkEntryBusy(entry);
      const bsig = busy ? "1" : "0";
      if (bsig !== tail.lastBusy) {
        tail.lastBusy = bsig;
        publishSid(tail.sid, "busy", { busy });
        if (!busy) void publishCurrentBatch(tail);
      }
      if (!busy) tail.lastDraft.delete(tail.sid);
      return;
    }
    const pane = capturePane(tail.pane.target);
    const prompt = await resolveSessionPrompt(tail.pane.tp, pane);
    const sig = prompt ? JSON.stringify(prompt) : "";
    if (sig !== tail.lastSig) {
      tail.lastSig = sig;
      publishSid(tail.sid, "prompt", { prompt: prompt ?? null });
    }
    const busy = pane ? isBusy(pane) : false;
    const bsig = busy ? "1" : "0";
    if (bsig !== tail.lastBusy) {
      tail.lastBusy = bsig;
      publishSid(tail.sid, "busy", { busy });
      if (!busy) void publishCurrentBatch(tail);
    }
  };

  const pollDraft = (tail: SidTail) => {
    const entry = findEntryByAnyId(tail.sid);
    if (!entry || !isAisdkEntryBusy(entry)) return;
    sendAiTextDeltaPart((type, fields) => publishSid(tail.sid, type, fields), tail.sid, entry, tail.lastDraft);
  };

  const ensureSidTail = async (sid: string, tp: string | null): Promise<SidTail> => {
    const existing = sidTails.get(sid);
    if (existing) return existing;
    const tail: SidTail = {
      sid,
      sockets: new Set(),
      pane: { sid, tp, target: null },
      offset: tp ? Bun.file(tp).size : 0,
      buf: "",
      lastSig: " ",
      lastBusy: "?",
      lastQ: "[]",
      lastArtifactAt: 0,
      lastDraft: new Map(),
      pumpInterval: null,
      pollInterval: null,
      draftInterval: null,
    };
    sidTails.set(sid, tail);
    if (tp) enqueueTranscriptIndex(tp, sid);
    void hydrateTarget(tail).then(() => void pollOne(tail));
    pollArtifacts(tail);
    pollQueue(tail);
    tail.pumpInterval = setInterval(() => void pumpOne(tail), 700);
    tail.pollInterval = setInterval(() => {
      void pollOne(tail);
      pollArtifacts(tail);
      pollQueue(tail);
      void reconcileQueued(tail.sid).then((changed) => changed && pollQueue(tail));
    }, 1000);
    tail.draftInterval = setInterval(() => pollDraft(tail), 150);
    return tail;
  };

  const readBacklog = async (sid: string, tp: string) => {
    const backlogT0 = performance.now();
    const page = await indexedMessagePage(tp, sid, { limit: BACKLOG_LIMIT });
    const messages = page?.messages ?? await recentMessagesCached(tp, BACKLOG_LIMIT);
    const readMs = performance.now() - backlogT0;
    const renderT0 = performance.now();
    const rendered = transcriptMessagesForClient(sid, messages).map(msgWithHtml).slice(-BACKLOG_LIMIT);
    const renderMs = performance.now() - renderT0;
    evlog("ws_backlog", {
      sid,
      messages: rendered.length,
      nextBefore: page?.nextBefore ?? null,
      readMs: roundMs(readMs),
      renderMs: roundMs(renderMs),
      totalMs: roundMs(performance.now() - backlogT0),
    });
    return { messages: rendered, nextBefore: page?.nextBefore ?? null, readMs, renderMs };
  };

  async function publishCurrentBatch(tail: SidTail): Promise<void> {
    let tp = tail.pane.tp;
    if (!tp) {
      tp = await resolveTranscript(tail.sid);
      if (!tp) return;
      tail.pane.tp = tp;
      enqueueTranscriptIndex(tp, tail.sid);
    }
    const backlog = await readBacklog(tail.sid, tp);
    publishSid(tail.sid, "batch", {
      messages: backlog.messages,
      nextBefore: backlog.nextBefore,
    });
    if (backlog.messages.length) {
      tail.lastArtifactAt = Math.max(
        tail.lastArtifactAt,
        ...backlog.messages
          .filter((msg) => msg.kind === "image" || msg.kind === "video")
          .map((msg) => msg.ts ?? 0),
      );
    }
  }

  const subscribeOne = async (state: SocketState, sid: string, resync: boolean) => {
    const first = !state.subscribed.has(sid);
    if (!first && !resync) return;
    if (first && state.subscribed.size >= SUBSCRIPTION_CAP) {
      safeSend(state.ws, { t: "error", sid, message: `subscription cap exceeded (${SUBSCRIPTION_CAP})` });
      return;
    }
    const t0 = performance.now();
    state.subscribed.add(sid);
    const tp = await resolveTranscript(sid);
    const entry = findEntryByAnyId(sid);
    if (!tp && !entry) {
      sendSid(state, "batch", sid, { messages: [], nextBefore: null });
      evlog("ws_subscribe", { rid: state.rid, sid, missing: true, durationMs: roundMs(performance.now() - t0) });
      const tail = await ensureSidTail(sid, null);
      tail.sockets.add(state.ws);
      return;
    }
    let batchMessages: unknown[] = [];
    let nextBefore: number | null = null;
    if (tp) {
      enqueueTranscriptIndex(tp, sid);
      const backlog = await readBacklog(sid, tp);
      batchMessages = backlog.messages;
      nextBefore = backlog.nextBefore;
    }
    sendSid(state, "batch", sid, { messages: batchMessages, nextBefore });
    evlog("ws_subscribe", {
      rid: state.rid,
      sid,
      messages: batchMessages.length,
      durationMs: roundMs(performance.now() - t0),
    });
    const tail = await ensureSidTail(sid, tp);
    tail.sockets.add(state.ws);
    if (batchMessages.length) {
      tail.lastArtifactAt = Math.max(
        tail.lastArtifactAt,
        ...batchMessages
          .filter((msg): msg is { kind?: string; ts?: number | null } => typeof msg === "object" && !!msg)
          .filter((msg) => msg.kind === "image" || msg.kind === "video")
          .map((msg) => msg.ts ?? 0),
      );
    }
    void pollOne(tail);
    pollArtifacts(tail);
    pollQueue(tail);
  };

  const unsubscribeOne = (state: SocketState, sid: string) => {
    state.subscribed.delete(sid);
    state.seqBySid.delete(sid);
    const tail = sidTails.get(sid);
    if (tail) {
      tail.sockets.delete(state.ws);
      cleanupSidTail(sid);
    }
  };

  const backfill = async (state: SocketState, sid: string, before: number | null, limit: number) => {
    try {
      const tp = await resolveTranscript(sid);
      if (!tp) {
        sendSid(state, "error", sid, { message: "session transcript not found" });
        return;
      }
      enqueueTranscriptIndex(tp, sid);
      const bounded = Math.max(1, Math.min(200, limit || 80));
      const page =
        (await indexedMessagePage(tp, sid, { before, limit: bounded })) ??
        (await messagePage(tp, { before, limit: bounded }));
      const messages = transcriptMessagesForClient(sid, page.messages).map(msgWithHtml);
      safeSend(state.ws, {
        t: "page",
        sid,
        messages,
        hasMore: page.nextBefore != null,
        nextBefore: page.nextBefore ?? null,
      });
    } catch (e) {
      sendSid(state, "error", sid, { message: e instanceof Error ? e.message : String(e) });
    }
  };

  const closeSocket = (ws: LiveWs) => {
    const state = sockets.get(ws);
    if (!state || state.closed) return;
    state.closed = true;
    if (state.heartbeat) clearInterval(state.heartbeat);
    for (const sid of [...state.subscribed]) unsubscribeOne(state, sid);
    openSockets.delete(ws);
    stopStatusLoopIfIdle();
  };

  return {
    dataForRequest(): LiveWsSocketData {
      return {
        liveWs: true,
        rid: crypto.randomUUID?.() ?? `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      };
    },
    isLiveSocket(ws: ServerWebSocket<unknown>): boolean {
      return (ws.data as LiveWsSocketData | undefined)?.liveWs === true;
    },
    open(ws: LiveWs) {
      const rid = (ws.data as LiveWsSocketData | undefined)?.rid || "ws";
      const state: SocketState = {
        ws,
        rid,
        subscribed: new Set(),
        seqBySid: new Map(),
        closed: false,
        lastTraffic: Date.now(),
        heartbeat: null,
      };
      sockets.set(ws, state);
      openSockets.add(ws);
      evlog("ws_connect", { rid });
      ensureStatusLoop();
      state.heartbeat = setInterval(() => {
        if (state.closed) return;
        if (Date.now() - state.lastTraffic > IDLE_CLOSE_MS) {
          try {
            ws.close();
          } catch {}
          closeSocket(ws);
          return;
        }
        safeSend(ws, { t: "ping" });
      }, HEARTBEAT_MS);
    },
    message(ws: LiveWs, raw: string | Uint8Array | ArrayBuffer) {
      const state = sockets.get(ws);
      if (!state || state.closed || typeof raw !== "string") return;
      state.lastTraffic = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        safeSend(ws, { t: "error", message: "invalid json" });
        return;
      }
      const input = msg as {
        t?: string;
        ids?: unknown;
        sid?: unknown;
        before?: unknown;
        limit?: unknown;
        resync?: unknown;
      };
      if (input.t === "pong") return;
      if (input.t === "subscribe") {
        const ids = Array.isArray(input.ids)
          ? input.ids.filter((id): id is string => typeof id === "string" && SID_RE.test(id))
          : [];
        for (const sid of ids) void subscribeOne(state, sid, input.resync === true);
        return;
      }
      if (input.t === "unsubscribe") {
        const ids = Array.isArray(input.ids)
          ? input.ids.filter((id): id is string => typeof id === "string" && SID_RE.test(id))
          : [];
        for (const sid of ids) unsubscribeOne(state, sid);
        return;
      }
      if (input.t === "backfill" && typeof input.sid === "string" && SID_RE.test(input.sid)) {
        const before = typeof input.before === "number" && Number.isFinite(input.before)
          ? Math.max(0, input.before)
          : null;
        const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 80;
        void backfill(state, input.sid, before, limit);
        return;
      }
      safeSend(ws, { t: "error", message: "unknown live websocket message" });
    },
    close: closeSocket,
  };
}
