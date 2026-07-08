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
type HtmlMessage = {
  kind: string;
  text: string;
  html?: string;
  id?: string | null;
  ts?: number | null;
  artifactId?: string;
  url?: string;
  name?: string;
  size?: number;
};
type LivePane = { sid: string; tp: string | null; target: string | null };
type ChannelKind = "transcript" | "status" | "agent_run" | "summary" | "resumable";
type Channel = { kind: ChannelKind; key: string; resumeFromSeq?: number };
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

const EVLOG_DIR = join(PATHS.data, "evlogs");
const SID_RE = /^[0-9a-fA-F-]{36}$/;
const RUN_RE = /^[0-9a-f]+$/;
const SUBSCRIPTION_CAP = 48;
const BACKLOG_LIMIT = 40;
const HEARTBEAT_MS = 25_000;
const IDLE_CLOSE_MS = 60_000;
const RING_CAP = 256;

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

function mediaIdentity(message: { kind?: string; id?: string | null; artifactId?: string; url?: string; ts?: number | null; name?: string; size?: number; text?: string }): string | null {
  if (message.kind !== "image" && message.kind !== "video") return message.id ?? null;
  const artifactId = message.artifactId || artifactIdFromUrl(message.url);
  if (artifactId) return `artifact-${artifactId}`;
  if (message.url) return `media-${message.kind}-${message.url}`;
  if (message.id) return message.id;
  return `media-${message.kind}-${message.ts ?? "no-ts"}-${message.name ?? ""}-${message.size ?? ""}-${message.text ?? ""}`;
}

function normalizeMediaIdentity<T extends { kind: string; id?: string | null; artifactId?: string; url?: string; ts?: number | null; name?: string; size?: number; text?: string }>(message: T): T {
  const id = mediaIdentity(message);
  if (!id || id === message.id) return message;
  return { ...message, id };
}

function visibleTranscriptMessages<T extends { kind: string }>(messages: T[]): T[] {
  return messages.filter((message) => message.kind !== "tool_result");
}

function withImageArtifacts<T extends { kind: string; text: string; ts?: number | null; id?: string | null }>(
  sessionId: string,
  messages: T[],
): Array<T | ImageArtifactMessage> {
  const normalizedMessages = messages.map((message) => normalizeMediaIdentity(message));
  const artifacts = listImageArtifacts(sessionId).map((artifact) => normalizeMediaIdentity(imageArtifactToMessage(artifact)));
  if (!artifacts.length) return normalizedMessages;
  const seen = new Set(normalizedMessages.map(mediaIdentity).filter(Boolean));
  return [...normalizedMessages, ...artifacts.filter((artifact) => !seen.has(mediaIdentity(artifact)))]
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || String(mediaIdentity(a) ?? "").localeCompare(String(mediaIdentity(b) ?? "")));
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
  closed: boolean;
  lastTraffic: number;
  heartbeat: ReturnType<typeof setInterval> | null;
};

type ChannelState = {
  seq: number;
  ring: Array<{ seq: number; frame: Record<string, unknown> }>;
};

type SummaryTail = {
  sid: string;
  started: boolean;
  done: boolean;
  text: string;
  error: string | null;
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

export function createLiveWsSupport(opts: {
  evlog?: Evlog;
  getAgentRun?: (runId: string) => AgentRunSnapshot | null;
  subscribeAgentRun?: (runId: string, cb: (event: AgentRunEvent) => void) => () => void;
  streamSummary?: (sid: string, onChunk: (chunk: string) => void) => Promise<void>;
} = {}) {
  const evlog = opts.evlog ?? defaultEvlog;
  const sockets = new WeakMap<LiveWs, SocketState>();
  const sidTails = new Map<string, SidTail>();
  const channelStates = new Map<string, ChannelState>();
  const agentRunUnsubs = new Map<string, () => void>();
  const summaryTails = new Map<string, SummaryTail>();
  const openSockets = new Set<LiveWs>();
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let lastStatusSig = "";
  let statusPublishing = false;

  const channelId = (channel: Pick<Channel, "kind" | "key">): string => `${channel.kind}:${channel.key}`;
  const transcriptChannel = (sid: string): Channel => ({ kind: "transcript", key: sid });
  const statusChannel = (): Channel => ({ kind: "status", key: "*" });

  const channelFromId = (id: string): Channel | null => {
    const sep = id.indexOf(":");
    if (sep <= 0) return null;
    const kind = id.slice(0, sep) as ChannelKind;
    const key = id.slice(sep + 1);
    if (!key) return null;
    return { kind, key };
  };

  const stateForChannel = (channel: Pick<Channel, "kind" | "key">): ChannelState => {
    const id = channelId(channel);
    let state = channelStates.get(id);
    if (!state) {
      state = { seq: 0, ring: [] };
      channelStates.set(id, state);
    }
    return state;
  };

  const nextSeq = (channel: Pick<Channel, "kind" | "key">): number => {
    const state = stateForChannel(channel);
    state.seq += 1;
    return state.seq;
  };

  const stamp = (channel: Pick<Channel, "kind" | "key">, frame: Record<string, unknown>): Record<string, unknown> => {
    const seq = nextSeq(channel);
    return { ...frame, kind: channel.kind, key: channel.key, seq };
  };

  const rememberDelta = (channel: Pick<Channel, "kind" | "key">, frame: Record<string, unknown>) => {
    const state = stateForChannel(channel);
    const seq = typeof frame.seq === "number" ? frame.seq : state.seq;
    state.ring.push({ seq, frame });
    if (state.ring.length > RING_CAP) state.ring.splice(0, state.ring.length - RING_CAP);
  };

  const sendChannel = (
    state: SocketState,
    channel: Pick<Channel, "kind" | "key">,
    frame: Record<string, unknown>,
    opts: { remember?: boolean } = {},
  ) => {
    if (state.closed || !state.subscribed.has(channelId(channel))) return;
    const stamped = stamp(channel, frame);
    if (opts.remember) rememberDelta(channel, stamped);
    safeSend(state.ws, stamped);
  };

  const publishChannelDelta = (channel: Pick<Channel, "kind" | "key">, delta: Record<string, unknown>) => {
    const frame = stamp(channel, { t: "delta", delta });
    rememberDelta(channel, frame);
    const id = channelId(channel);
    for (const ws of openSockets) {
      const state = sockets.get(ws);
      if (!state || state.closed || !state.subscribed.has(id)) continue;
      safeSend(ws, frame);
    }
  };

  const publishSid = (sid: string, type: SendType, fields: Record<string, unknown>) => {
    publishChannelDelta(transcriptChannel(sid), { t: type, sid, ...fields });
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
        const frame = stamp(statusChannel(), { t: "status", rows });
        for (const ws of openSockets) safeSend(ws, frame);
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
      // Keep the SQLite index continuously caught up for live sessions: the
      // pump already knows the file grew, and enqueueTranscriptIndex is
      // incremental (cursor-based) + deduped per path, so this only parses
      // the new bytes in the background.
      enqueueTranscriptIndex(tail.pane.tp, tail.sid);
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
    const messages = imageArtifactMessagesSince(tail.sid, tail.lastArtifactAt)
      .map((message) => normalizeMediaIdentity(message))
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || String(mediaIdentity(a) ?? "").localeCompare(String(mediaIdentity(b) ?? "")));
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
    const rendered = transcriptMessagesForClient(sid, messages).map(msgWithHtml);
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
    const channel = transcriptChannel(tail.sid);
    const frame = stamp(channel, {
      t: "snapshot",
      sid: tail.sid,
      messages: backlog.messages,
      nextBefore: backlog.nextBefore,
    });
    const id = channelId(channel);
    for (const ws of tail.sockets) {
      const state = sockets.get(ws);
      if (state && !state.closed && state.subscribed.has(id)) safeSend(ws, frame);
    }
    if (backlog.messages.length) {
      tail.lastArtifactAt = Math.max(
        tail.lastArtifactAt,
        ...backlog.messages
          .filter((msg) => msg.kind === "image" || msg.kind === "video")
          .map((msg) => msg.ts ?? 0),
      );
    }
  }

  const replayOrSnapshot = async (
    state: SocketState,
    channel: Channel,
    snapshot: () => Promise<Record<string, unknown>>,
  ): Promise<boolean> => {
    const chState = stateForChannel(channel);
    const resumeFromSeq = typeof channel.resumeFromSeq === "number" && Number.isFinite(channel.resumeFromSeq)
      ? Math.max(0, channel.resumeFromSeq)
      : null;
    if (resumeFromSeq != null && chState.ring.length && resumeFromSeq >= chState.ring[0].seq - 1 && resumeFromSeq <= chState.seq) {
      let replayed = 0;
      for (const item of chState.ring) {
        if (item.seq > resumeFromSeq) {
          safeSend(state.ws, item.frame);
          replayed++;
        }
      }
      safeSend(state.ws, stamp(channel, { t: "resumed", fromSeq: resumeFromSeq, toSeq: chState.seq, replayed }));
      return true;
    }
    if (resumeFromSeq != null && resumeFromSeq > 0) safeSend(state.ws, stamp(channel, { t: "gap" }));
    safeSend(state.ws, stamp(channel, await snapshot()));
    return false;
  };

  const subscribeTranscript = async (state: SocketState, channel: Channel, resync: boolean) => {
    const sid = channel.key;
    const id = channelId(channel);
    const first = !state.subscribed.has(id);
    if (!first && !resync) return;
    if (first && state.subscribed.size >= SUBSCRIPTION_CAP) {
      safeSend(state.ws, { t: "error", sid, message: `subscription cap exceeded (${SUBSCRIPTION_CAP})` });
      return;
    }
    const t0 = performance.now();
    state.subscribed.add(id);
    const tp = await resolveTranscript(sid);
    const entry = findEntryByAnyId(sid);
    if (!tp && !entry) {
      await replayOrSnapshot(state, channel, async () => ({ t: "snapshot", sid, messages: [], nextBefore: null }));
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
    await replayOrSnapshot(state, channel, async () => ({ t: "snapshot", sid, messages: batchMessages, nextBefore }));
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

  const unsubscribeTranscript = (state: SocketState, sid: string) => {
    state.subscribed.delete(channelId(transcriptChannel(sid)));
    const tail = sidTails.get(sid);
    if (tail) {
      tail.sockets.delete(state.ws);
      cleanupSidTail(sid);
    }
  };

  const subscribeAgentRun = async (state: SocketState, channel: Channel, resync: boolean) => {
    const id = channelId(channel);
    const first = !state.subscribed.has(id);
    if (!first && !resync) return;
    if (first && state.subscribed.size >= SUBSCRIPTION_CAP) {
      safeSend(state.ws, { t: "error", kind: channel.kind, key: channel.key, message: `subscription cap exceeded (${SUBSCRIPTION_CAP})` });
      return;
    }
    const snapshot = opts.getAgentRun?.(channel.key) ?? null;
    if (!snapshot) {
      safeSend(state.ws, stamp(channel, { t: "error", code: "not_found", message: "run not found" }));
      return;
    }
    state.subscribed.add(id);
    await replayOrSnapshot(state, channel, async () => ({ t: "snapshot", run: snapshot }));
    if (!agentRunUnsubs.has(channel.key) && snapshot.status === "running" && opts.subscribeAgentRun) {
      const unsub = opts.subscribeAgentRun(channel.key, (event) => {
        publishChannelDelta(channel, { event });
        if (event.type === "done" || event.type === "failed") {
          agentRunUnsubs.get(channel.key)?.();
          agentRunUnsubs.delete(channel.key);
        }
      });
      agentRunUnsubs.set(channel.key, unsub);
    }
  };

  const subscribeSummary = async (state: SocketState, channel: Channel, resync: boolean) => {
    const id = channelId(channel);
    const first = !state.subscribed.has(id);
    if (!first && !resync) return;
    if (first && state.subscribed.size >= SUBSCRIPTION_CAP) {
      safeSend(state.ws, { t: "error", kind: channel.kind, key: channel.key, message: `subscription cap exceeded (${SUBSCRIPTION_CAP})` });
      return;
    }
    state.subscribed.add(id);
    let tail = summaryTails.get(channel.key);
    if (tail?.done && channel.resumeFromSeq == null) {
      tail = undefined;
      summaryTails.delete(channel.key);
    }
    if (!tail) {
      tail = { sid: channel.key, started: false, done: false, text: "", error: null };
      summaryTails.set(channel.key, tail);
    }
    await replayOrSnapshot(state, channel, async () => ({
      t: "snapshot",
      text: tail.text,
      done: tail.done,
      error: tail.error,
    }));
    if (tail.started || tail.done) return;
    tail.started = true;
    if (!opts.streamSummary) {
      tail.done = true;
      tail.error = "summary stream unavailable";
      publishChannelDelta(channel, { error: tail.error, done: true });
      return;
    }
    void opts.streamSummary(channel.key, (chunk) => {
      if (!chunk) return;
      tail.text += chunk;
      publishChannelDelta(channel, { chunk });
    }).then(() => {
      tail.done = true;
      publishChannelDelta(channel, { done: true });
    }).catch((e) => {
      tail.done = true;
      tail.error = e instanceof Error ? e.message : String(e);
      publishChannelDelta(channel, { error: tail.error, done: true });
    });
  };

  const unsubscribeChannel = (state: SocketState, id: string) => {
    const channel = channelFromId(id);
    if (!channel) {
      state.subscribed.delete(id);
      return;
    }
    if (channel.kind === "transcript") {
      unsubscribeTranscript(state, channel.key);
      return;
    }
    state.subscribed.delete(id);
  };

  const backfill = async (state: SocketState, sid: string, before: number | null, limit: number) => {
    try {
      const tp = await resolveTranscript(sid);
      if (!tp) {
        sendChannel(state, transcriptChannel(sid), { t: "error", sid, message: "session transcript not found" });
        return;
      }
      enqueueTranscriptIndex(tp, sid);
      const bounded = Math.max(1, Math.min(200, limit || 80));
      const page =
        (await indexedMessagePage(tp, sid, { before, limit: bounded })) ??
        (await messagePage(tp, { before, limit: bounded }));
      const messages = transcriptMessagesForClient(sid, page.messages).map(msgWithHtml);
      safeSend(state.ws, stamp(transcriptChannel(sid), {
        t: "page",
        sid,
        messages,
        hasMore: page.nextBefore != null,
        nextBefore: page.nextBefore ?? null,
      }));
    } catch (e) {
      sendChannel(state, transcriptChannel(sid), { t: "error", sid, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const closeSocket = (ws: LiveWs) => {
    const state = sockets.get(ws);
    if (!state || state.closed) return;
    state.closed = true;
    if (state.heartbeat) clearInterval(state.heartbeat);
    for (const id of [...state.subscribed]) unsubscribeChannel(state, id);
    openSockets.delete(ws);
    stopStatusLoopIfIdle();
  };

  const validChannel = (value: unknown): Channel | null => {
    if (!value || typeof value !== "object") return null;
    const v = value as { kind?: unknown; key?: unknown; resumeFromSeq?: unknown };
    if (typeof v.kind !== "string" || typeof v.key !== "string") return null;
    if (v.kind === "transcript" && SID_RE.test(v.key)) {
      return {
        kind: "transcript",
        key: v.key,
        resumeFromSeq: typeof v.resumeFromSeq === "number" && Number.isFinite(v.resumeFromSeq) ? v.resumeFromSeq : undefined,
      };
    }
    if (v.kind === "agent_run" && RUN_RE.test(v.key)) {
      return {
        kind: "agent_run",
        key: v.key,
        resumeFromSeq: typeof v.resumeFromSeq === "number" && Number.isFinite(v.resumeFromSeq) ? v.resumeFromSeq : undefined,
      };
    }
    if (v.kind === "summary" && SID_RE.test(v.key)) {
      return {
        kind: "summary",
        key: v.key,
        resumeFromSeq: typeof v.resumeFromSeq === "number" && Number.isFinite(v.resumeFromSeq) ? v.resumeFromSeq : undefined,
      };
    }
    if ((v.kind === "status" || v.kind === "resumable") && v.key === "*") {
      return {
        kind: v.kind,
        key: "*",
        resumeFromSeq: typeof v.resumeFromSeq === "number" && Number.isFinite(v.resumeFromSeq) ? v.resumeFromSeq : undefined,
      };
    }
    return null;
  };

  const subscribeChannel = (state: SocketState, channel: Channel, resync: boolean) => {
    if (channel.kind === "transcript") {
      void subscribeTranscript(state, channel, resync);
      return;
    }
    if (channel.kind === "agent_run") {
      void subscribeAgentRun(state, channel, resync);
      return;
    }
    if (channel.kind === "summary") {
      void subscribeSummary(state, channel, resync);
      return;
    }
    state.subscribed.add(channelId(channel));
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
        channels?: unknown;
        kind?: unknown;
        key?: unknown;
        sid?: unknown;
        before?: unknown;
        limit?: unknown;
        resync?: unknown;
      };
      if (input.t === "pong") return;
      if (input.t === "subscribe") {
        const channels = Array.isArray(input.channels)
          ? input.channels.map(validChannel).filter((channel): channel is Channel => !!channel)
          : [];
        const ids = Array.isArray(input.ids)
          ? input.ids.filter((id): id is string => typeof id === "string" && SID_RE.test(id))
          : [];
        for (const sid of ids) channels.push(transcriptChannel(sid));
        for (const channel of channels) subscribeChannel(state, channel, input.resync === true);
        return;
      }
      if (input.t === "unsubscribe") {
        const channels = Array.isArray(input.channels)
          ? input.channels.map(validChannel).filter((channel): channel is Channel => !!channel)
          : [];
        const ids = Array.isArray(input.ids)
          ? input.ids.filter((id): id is string => typeof id === "string" && SID_RE.test(id))
          : [];
        for (const sid of ids) channels.push(transcriptChannel(sid));
        for (const channel of channels) unsubscribeChannel(state, channelId(channel));
        return;
      }
      const backfillSid = typeof input.sid === "string" && SID_RE.test(input.sid)
        ? input.sid
        : input.kind === "transcript" && typeof input.key === "string" && SID_RE.test(input.key)
          ? input.key
          : null;
      if (input.t === "backfill" && backfillSid) {
        const before = typeof input.before === "number" && Number.isFinite(input.before)
          ? Math.max(0, input.before)
          : null;
        const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : 80;
        void backfill(state, backfillSid, before, limit);
        return;
      }
      safeSend(ws, { t: "error", message: "unknown live websocket message" });
    },
    close: closeSocket,
  };
}
