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

function escapeHtml(value: string) {
  return value.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
}

function normText(value?: string) {
  return (value || "").replace(/\s+/g, " ").trim();
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

function upsertLfgUIMessage(current: LfgChatMessage[], incoming: LfgChatMessage): LfgChatMessage[] {
  const byIdIndex = current.findIndex((message) => message.id === incoming.id);
  if (byIdIndex >= 0) {
    if (current[byIdIndex] === incoming) return current;
    const next = [...current];
    next[byIdIndex] = incoming;
    return next;
  }

  let next = current;
  const incomingLfg = incoming.metadata?.lfgMessage;
  if (incomingLfg?.role === "user" && incomingLfg.kind === "text") {
    const incomingText = normText(incomingLfg.text);
    const pendingIndex = current.findIndex((message) => {
      const lfg = message.metadata?.lfgMessage;
      return (
        message.role === "user" &&
        !!lfg?.pending &&
        lfg.kind === "text" &&
        normText(lfg.text) === incomingText
      );
    });
    if (pendingIndex >= 0) {
      next = [...current];
      next[pendingIndex] = incoming;
      return next;
    }
  }

  if (incomingLfg?.role === "assistant" && incomingLfg.kind === "text") {
    next = current.filter((message) => {
      if (message.role !== "assistant") return true;
      return !message.parts.some((part) => part.type === "text" && part.state === "streaming");
    });
  }

  const ts = messageTs(incoming);
  const insertAt =
    ts > 0
      ? next.findIndex((existing) => {
          const existingTs = messageTs(existing);
          return existingTs > 0 && existingTs > ts;
        })
      : -1;
  const out = [...next];
  if (insertAt >= 0) out.splice(insertAt, 0, incoming);
  else out.push(incoming);
  return out;
}

function updateDraftText(current: LfgChatMessage[], part: LfgAiStreamPart): LfgChatMessage[] {
  if (!part.id) return current;
  const existingIndex = current.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((item) => item.type === "text" && message.id === part.id),
  );
  if (part.type === "text-end") {
    if (existingIndex < 0) return current;
    const existing = current[existingIndex];
    const nextMessage: LfgChatMessage = {
      ...existing,
      parts: existing.parts.map((item) =>
        item.type === "text" ? { ...item, state: "done" as const } : item,
      ),
    };
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  if (part.type !== "text-delta" && part.type !== "text-start") return current;
  const incoming = part.reset ? (part.text ?? part.delta ?? "") : (part.delta ?? part.text ?? "");
  if (!incoming && existingIndex >= 0) return current;
  if (existingIndex >= 0) {
    const existing = current[existingIndex];
    const nextMessage: LfgChatMessage = {
      ...existing,
      metadata: {
        lfgMessage: {
          ...(existing.metadata?.lfgMessage ?? {}),
          id: part.id,
          role: "assistant",
          kind: "text",
          ts: part.ts ?? existing.metadata?.lfgMessage?.ts ?? Date.now(),
        },
      },
      parts: existing.parts.map((item) =>
        item.type === "text"
          ? {
              ...item,
              text: part.reset ? incoming : `${item.text}${incoming}`,
              state: "streaming" as const,
            }
          : item,
      ),
    };
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  if (!incoming) return current;
  return [
    ...current,
    {
      id: part.id,
      role: "assistant",
      metadata: {
        lfgMessage: {
          id: part.id,
          role: "assistant",
          kind: "text",
          text: incoming,
          ts: part.ts ?? Date.now(),
        },
      },
      parts: [{ type: "text", text: incoming, state: "streaming" }],
    },
  ];
}

export function appendLfgTranscriptEvent(
  current: LfgChatMessage[],
  event: LfgTranscriptEvent,
  opts: { streamActive?: boolean } = {},
): LfgChatMessage[] {
  if (event.type === "message") {
    if (event.message.seed) return current;
    if (opts.streamActive && event.message.role !== "user") return current;
    const [message] = lfgMessagesToUIMessages([event.message]);
    return message ? upsertLfgUIMessage(current, message) : current;
  }
  if (event.type === "ai_part") {
    return opts.streamActive ? current : updateDraftText(current, event.part);
  }
  if (event.type === "busy" && !event.busy) {
    // Turn ended: any assistant message still marked streaming is a stale
    // draft. The server never emits an explicit end for drafts (it just stops
    // sending deltas — heavy on claude, rare on codex), and the finalized row
    // for the same text is already indexed/upserted, so a leftover streaming
    // bubble would sit there animating forever.
    const next = current.filter(
      (message) =>
        message.role !== "assistant" ||
        !message.parts.some((part) => part.type === "text" && part.state === "streaming"),
    );
    return next.length === current.length ? current : next;
  }
  return current;
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
      // busy:false only ends the stream promptly once we've actually seen
      // content. The serve's 1s poll re-emits the CURRENT (still idle) busy
      // state right after a send — the old 500ms grace let that pre-flip frame
      // close the stream with zero content, dropping chatStatus to "ready" so
      // the working indicator never appeared. A content-less stream still gets
      // a long-grace close so an interrupted/failed turn can't wedge the
      // composer, and busy:true cancels any pending close.
      if (event.busy) this.clearFinishTimer();
      else if (this.sawContent) this.finishSoon();
      else this.finishSoon(15_000);
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
    const current = this.textById[part.id] ?? "";
    let delta = incoming;
    if (part.reset && current) {
      // A reset is a full snapshot of the draft, not another delta. The AI SDK
      // stream protocol is append-only, so forward only the newly-grown suffix.
      // Replaying the whole snapshot made the live bubble repeat once per poll;
      // a reload appeared to fix it because indexed history contains one row.
      if (!incoming.startsWith(current)) return;
      delta = incoming.slice(current.length);
    }
    if (part.type === "text-start" && !this.activeTextIds.has(part.id)) this.startText(part.id);
    if (!incoming || !delta) return;
    if (!this.activeTextIds.has(part.id)) this.startText(part.id);
    this.textById[part.id] = part.reset ? incoming : `${current}${incoming}`;
    this.enqueue({ type: "text-delta", id: part.id, delta });
  }

  private handleMessage(message: LfgMessage) {
    if (message.role === "user" && message.kind === "text") return;
    this.sawContent = true;
    this.clearFinishTimer();
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

  private finishSoon(delayMs = 80) {
    this.clearFinishTimer();
    this.finishTimer = setTimeout(() => {
      for (const id of [...this.activeTextIds]) this.endText(id);
      this.enqueue({ type: "finish", finishReason: "stop" });
      this.close();
    }, delayMs);
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
  private readonly subscribeTranscript?: LfgTranscriptSubscribe;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiBase: string;
  private readonly sessionId: string;

  constructor({ sessionId, apiBase = "", subscribeTranscript, fetch: fetchImpl }: LfgChatTransportOptions) {
    this.sessionId = sessionId;
    this.apiBase = apiBase;
    this.subscribeTranscript = subscribeTranscript;
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
        if (!this.subscribeTranscript) {
          controller.enqueue({ type: "error", errorText: "live transcript subscription is unavailable" });
          controller.close();
          return;
        }
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
