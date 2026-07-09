import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

export type LfgMessage = {
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
  pending?: boolean;
  seed?: boolean;
  catchUp?: boolean;
};

export type LfgAiStreamPart = {
  type: "text-delta" | "text-start" | "text-end" | "error" | string;
  id?: string;
  delta?: string;
  text?: string;
  reset?: boolean;
  ts?: number;
};

export type LfgChatMetadata = {
  lfgMessage?: LfgMessage;
};

export type LfgChatDataParts = {
  lfgMessage: LfgMessage;
};

export type LfgChatMessage = UIMessage<LfgChatMetadata, LfgChatDataParts>;

export type LfgTranscriptEvent =
  | { type: "message"; message: LfgMessage }
  | { type: "ai_part"; part: LfgAiStreamPart }
  | { type: "busy"; busy: boolean }
  | { type: "error"; error: string };

export type LfgTranscriptSubscribe = (
  sid: string,
  listener: (event: LfgTranscriptEvent) => void,
) => () => void;

type LfgChatTransportOptions = {
  sessionId: string;
  apiBase?: string;
  subscribeTranscript?: LfgTranscriptSubscribe;
  fetch?: typeof globalThis.fetch;
};

type LiveFrame =
  | { t?: "msg"; sid?: string; message?: LfgMessage; m?: LfgMessage }
  | { t?: "ai_part"; sid?: string; part?: LfgAiStreamPart }
  | { t?: "busy"; sid?: string; busy?: boolean }
  | {
      t?: "delta";
      kind?: string;
      key?: string;
      delta?: {
        t?: string;
        sid?: string;
        message?: LfgMessage;
        m?: LfgMessage;
        part?: LfgAiStreamPart;
        busy?: boolean;
        error?: string | null;
      };
    }
  | { t?: "error"; message?: string; error?: string };

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

function messageTs(message: LfgChatMessage) {
  return message.metadata?.lfgMessage?.ts ?? 0;
}

function textFromUIParts(message: LfgChatMessage) {
  return message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function localMessageFromText(message: LfgMessage): LfgChatMessage {
  const role = message.role === "user" || message.role === "system" ? message.role : "assistant";
  return {
    id: message.id ?? `${role}-${message.ts ?? Date.now()}-${normText(message.text).slice(0, 16)}`,
    role,
    metadata: { lfgMessage: message },
    parts: [{ type: "text", text: message.text ?? "", state: "done" }],
  };
}

function localMessageFromData(message: LfgMessage): LfgChatMessage {
  return {
    id: message.id ?? `lfg-${message.kind ?? "message"}-${message.ts ?? Date.now()}`,
    role: message.role === "user" || message.role === "system" ? message.role : "assistant",
    metadata: { lfgMessage: message },
    parts: [{ type: "data-lfgMessage", id: message.id, data: message }],
  };
}

export function lfgMessagesToUIMessages(messages: LfgMessage[]): LfgChatMessage[] {
  return messages
    .filter((message) => !message.seed)
    .map((message) =>
      message.kind === "text" && (message.role === "user" || message.role === "assistant" || message.role === "system")
        ? localMessageFromText(message)
        : localMessageFromData(message),
    );
}

export function mergeLfgUIMessages(current: LfgChatMessage[], incoming: LfgChatMessage[]): LfgChatMessage[] {
  if (!incoming.length) return current;
  if (!current.length) return incoming;

  const next = [...current];
  const byId = new Map(next.map((message, index) => [message.id, index] as const));
  let changed = false;

  for (const message of incoming) {
    const existingIndex = byId.get(message.id);
    if (existingIndex != null) {
      const existing = next[existingIndex];
      if (existing.metadata?.lfgMessage?.pending && !message.metadata?.lfgMessage?.pending) {
        next[existingIndex] = message;
        changed = true;
      }
      continue;
    }

    const incomingText = textFromUIParts(message);
    if (
      incomingText &&
      next.some((existing) => existing.role === message.role && sameMessageNeedle(textFromUIParts(existing), incomingText))
    ) {
      continue;
    }

    const ts = messageTs(message);
    const insertAt =
      ts > 0
        ? next.findIndex((existing) => {
            const existingTs = messageTs(existing);
            return existingTs > 0 && existingTs > ts;
          })
        : -1;
    if (insertAt >= 0) next.splice(insertAt, 0, message);
    else next.push(message);
    byId.clear();
    next.forEach((item, index) => byId.set(item.id, index));
    changed = true;
  }

  return changed ? next : current;
}

export function lfgUIMessagesToMessages(messages: LfgChatMessage[]): LfgMessage[] {
  const out: LfgMessage[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) => {
      if (part.type === "data-lfgMessage") {
        out.push(part.data);
        return;
      }
      if (part.type === "reasoning") {
        out.push({
          id: `${message.id}-reasoning-${index}`,
          role: "assistant",
          kind: "thinking",
          text: part.text,
          ts: message.metadata?.lfgMessage?.ts,
        });
        return;
      }
      if (part.type === "file") {
        const top = part.mediaType.split("/")[0];
        out.push({
          id: `${message.id}-file-${index}`,
          role: message.role,
          kind: top === "video" ? "video" : "image",
          url: part.url,
          mimeType: part.mediaType,
          name: part.filename,
          ts: message.metadata?.lfgMessage?.ts,
        });
        return;
      }
      if (part.type !== "text") return;
      const base = message.metadata?.lfgMessage;
      const streaming = message.role === "assistant" && part.state === "streaming";
      const id =
        index === 0
          ? streaming
            ? `draft-${message.id}`
            : message.id
          : `${streaming ? "draft-" : ""}${message.id}-text-${index}`;
      out.push({
        ...base,
        id,
        role: message.role,
        kind: "text",
        text: part.text,
        html: message.role === "user" ? escapeHtml(part.text).replace(/\n/g, "<br>") : base?.html,
        pending: base?.pending,
        catchUp: base?.catchUp,
      });
    });
  }
  return out.filter((message) => message.kind !== "text" || !!message.text || message.role !== "assistant");
}

function wsUrl(apiBase: string, path: string): string {
  const base = apiBase || (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8766");
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizeLiveFrame(frame: LiveFrame, sid: string): LfgTranscriptEvent | null {
  if (frame.t === "delta" && frame.kind === "transcript") {
    const delta = frame.delta;
    if (!delta) return null;
    const nested = {
        t: delta.t as LiveFrame["t"],
        sid: delta.sid ?? frame.key,
        message: delta.message,
        m: delta.m,
        part: delta.part,
        busy: delta.busy,
        error: delta.error ?? undefined,
      } as LiveFrame;
    return normalizeLiveFrame(nested, sid);
  }
  if ("sid" in frame && frame.sid && frame.sid !== sid) return null;
  if (frame.t === "msg") {
    const message = frame.message ?? frame.m;
    return message ? { type: "message", message } : null;
  }
  if (frame.t === "ai_part" && frame.part) return { type: "ai_part", part: frame.part };
  if (frame.t === "busy") return { type: "busy", busy: !!frame.busy };
  if (frame.t === "error") return { type: "error", error: frame.message || frame.error || "live socket error" };
  return null;
}

function createWebSocketSubscriber(apiBase = ""): LfgTranscriptSubscribe {
  return (sid, listener) => {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) throw new Error("WebSocket is not available in this runtime");
    const ws = new WebSocketCtor(wsUrl(apiBase, "/api/live/ws"));
    let closed = false;
    ws.addEventListener("open", () => {
      if (closed) return;
      ws.send(JSON.stringify({ t: "subscribe", channels: [{ kind: "transcript", key: sid }] }));
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const normalized = normalizeLiveFrame(JSON.parse(event.data) as LiveFrame, sid);
        if (normalized) listener(normalized);
      } catch {
        // Ignore malformed live frames; the main socket layer does the same.
      }
    });
    ws.addEventListener("error", () => listener({ type: "error", error: "live socket error" }));
    return () => {
      closed = true;
      try {
        ws.close();
      } catch {
        // noop
      }
    };
  };
}

class LfgChunkEmitter {
  private activeTextIds = new Set<string>();
  private textById: Record<string, string> = {};
  private closed = false;
  private sawContent = false;
  private createdAt = Date.now();
  private finishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private controller: ReadableStreamDefaultController<UIMessageChunk>,
    private onClose?: () => void,
  ) {}

  handle(event: LfgTranscriptEvent) {
    if (this.closed) return;
    if (event.type === "error") {
      this.enqueue({ type: "error", errorText: event.error });
      this.close();
      return;
    }
    if (event.type === "busy") {
      if (!event.busy && (this.sawContent || Date.now() - this.createdAt > 500)) this.finishSoon();
      return;
    }
    if (event.type === "ai_part") {
      this.handlePart(event.part);
      return;
    }
    this.handleMessage(event.message);
  }

  abort(reason?: string) {
    if (this.closed) return;
    this.enqueue({ type: "abort", reason });
    this.close();
  }

  private handlePart(part: LfgAiStreamPart) {
    if (!part.id) return;
    if (part.type === "text-end") {
      this.endText(part.id);
      this.finishSoon();
      return;
    }
    if (part.type === "error") {
      this.enqueue({ type: "error", errorText: part.text || part.delta || "streaming error" });
      this.close();
      return;
    }
    if (part.type !== "text-delta" && part.type !== "text-start") return;
    const incoming = part.reset ? (part.text ?? part.delta ?? "") : (part.delta ?? part.text ?? "");
    if (part.type === "text-start" && !this.activeTextIds.has(part.id)) this.startText(part.id);
    if (!incoming) return;
    if (part.reset && this.activeTextIds.has(part.id) && this.textById[part.id]) {
      this.endText(part.id);
    }
    if (!this.activeTextIds.has(part.id)) this.startText(part.id);
    this.textById[part.id] = part.reset ? incoming : `${this.textById[part.id] ?? ""}${incoming}`;
    this.enqueue({ type: "text-delta", id: part.id, delta: incoming });
  }

  private handleMessage(message: LfgMessage) {
    if (message.role === "user" && message.kind === "text") return;
    this.sawContent = true;
    if (message.role === "assistant" && message.kind === "text") {
      const text = message.text ?? "";
      const active = [...this.activeTextIds][0];
      if (active) {
        const current = this.textById[active] ?? "";
        if (text.startsWith(current) && text.length > current.length) {
          this.enqueue({ type: "text-delta", id: active, delta: text.slice(current.length) });
          this.textById[active] = text;
        }
        this.endText(active);
      } else if (text) {
        const id = message.id ?? `assistant-${message.ts ?? Date.now()}`;
        this.startText(id);
        this.enqueue({ type: "text-delta", id, delta: text });
        this.textById[id] = text;
        this.endText(id);
      }
      this.finishSoon();
      return;
    }
    this.enqueue({ type: "data-lfgMessage", id: message.id, data: message });
  }

  private startText(id: string) {
    this.sawContent = true;
    this.clearFinishTimer();
    this.activeTextIds.add(id);
    this.enqueue({ type: "text-start", id });
  }

  private endText(id: string) {
    if (!this.activeTextIds.delete(id)) return;
    this.enqueue({ type: "text-end", id });
  }

  private finishSoon() {
    this.clearFinishTimer();
    this.finishTimer = setTimeout(() => {
      for (const id of [...this.activeTextIds]) this.endText(id);
      this.enqueue({ type: "finish", finishReason: "stop" });
      this.close();
    }, 80);
  }

  private clearFinishTimer() {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  private enqueue(chunk: UIMessageChunk) {
    if (this.closed) return;
    this.controller.enqueue(chunk);
  }

  private close() {
    if (this.closed) return;
    this.clearFinishTimer();
    this.closed = true;
    this.controller.close();
    this.onClose?.();
  }
}

export class LfgChatTransport implements ChatTransport<LfgChatMessage> {
  private readonly subscribeTranscript: LfgTranscriptSubscribe;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiBase: string;
  private readonly sessionId: string;

  constructor({ sessionId, apiBase = "", subscribeTranscript, fetch: fetchImpl }: LfgChatTransportOptions) {
    this.sessionId = sessionId;
    this.apiBase = apiBase;
    this.subscribeTranscript = subscribeTranscript ?? createWebSocketSubscriber(apiBase);
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async sendMessages({
    messages,
    abortSignal,
    body,
  }: Parameters<ChatTransport<LfgChatMessage>["sendMessages"]>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const text = this.extractLatestUserText(messages);
    if (!text) throw new Error("Cannot send an empty message");
    const stream = this.createStream(abortSignal);
    const response = await this.fetchImpl(this.httpUrl(`/api/sessions/${encodeURIComponent(this.sessionId)}/send`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mode: (body as { mode?: string } | undefined)?.mode }),
      signal: abortSignal,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error || `${response.status} ${response.statusText}`);
    }
    return stream;
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  private createStream(abortSignal?: AbortSignal): ReadableStream<UIMessageChunk> {
    let unsubscribe: (() => void) | null = null;
    let emitter: LfgChunkEmitter | null = null;
    const sid = this.sessionId;
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const cleanup = () => {
          unsubscribe?.();
          unsubscribe = null;
        };
        emitter = new LfgChunkEmitter(controller, cleanup);
        unsubscribe = this.subscribeTranscript(sid, (event) => emitter?.handle(event));
        abortSignal?.addEventListener("abort", () => {
          cleanup();
          emitter?.abort("aborted");
        }, { once: true });
      },
      cancel: () => {
        unsubscribe?.();
        unsubscribe = null;
        emitter = null;
      },
    });
  }

  private extractLatestUserText(messages: LfgChatMessage[]) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const text = textFromUIParts(message).trim();
      if (text) return text;
    }
    return "";
  }

  private httpUrl(path: string) {
    return new URL(path, this.apiBase || (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8766")).toString();
  }
}
