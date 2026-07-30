import type {
  LfgLiveChannel,
  LfgLiveMessage,
  LfgMessage,
  LfgMessagesResponse,
  LfgSendResponse,
  LfgSession,
  LfgSessionsResponse,
  LfgTranscriptEvent,
} from "@lfg-dev/protocol";

export type {
  LfgAiStreamPart,
  LfgLiveChannel,
  LfgLiveMessage,
  LfgMessage,
  LfgQueueMessage,
  LfgSession,
  LfgSessionPrompt,
  LfgStatusRow,
  LfgTranscriptEvent,
} from "@lfg-dev/protocol";

export interface LfgSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export interface LfgUploadProgress {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

export interface LfgTransport {
  /**
   * Authenticated raw HTTP access for application surfaces that consume
   * streams, blobs, or response headers. Small data clients can stay on
   * `request`, which parses JSON and normalizes errors.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Authenticated upload access with byte-level progress when the transport
   * can provide it. Older/custom transports may omit this; callers should
   * fall back to `fetch`.
   */
  upload?(
    path: string,
    init: RequestInit,
    onProgress: (progress: LfgUploadProgress) => void,
  ): Promise<Response>;
  request<T>(path: string, init?: RequestInit): Promise<T>;
  openLiveSocket(): Promise<LfgSocket>;
}

export interface LfgGrant {
  token: string;
  expiresAt: number;
}

export interface CreateGrantTransportOptions {
  baseUrl: string;
  getGrant: (input: { forceRefresh: boolean }) => Promise<LfgGrant>;
  fetch?: typeof globalThis.fetch;
  WebSocket?: typeof globalThis.WebSocket;
  XMLHttpRequest?: typeof globalThis.XMLHttpRequest;
}

const SOCKET_OPEN = 1;
const GRANT_REFRESH_SKEW_MS = 30_000;

/**
 * Read the body ONCE, then decide whether it was JSON. `response.json()` on a
 * non-JSON error consumed the body and left us with nothing to report, which is
 * how an intermediary's plain-text failure reached the UI as a bare number.
 */
async function readBody(response: Response): Promise<{ data: unknown; text: string }> {
  const text = await response.text().catch(() => "");
  if (!text) return { data: {}, text: "" };
  try {
    return { data: JSON.parse(text) as unknown, text };
  } catch {
    return { data: {}, text };
  }
}

function apiError(
  response: Response,
  method: string,
  path: string,
  data: unknown,
  text: string,
): Error {
  // lfg's own routes answer with { error }, and that copy is written for the
  // person reading it — pass it through untouched.
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
    return new Error(data.error);
  }
  // Anything else failed somewhere between here and lfg — a proxy, an edge, a
  // tunnel. `${status} ${statusText}` used to be the whole message, and HTTP/2
  // never sends statusText, so it rendered as a naked "405" with no way to tell
  // which request produced it. Name the request and quote whatever body came
  // back so the next one identifies itself.
  const detail = [response.statusText.trim(), text.trim().replace(/\s+/g, " ").slice(0, 200)]
    .filter(Boolean)
    .join(": ");
  return new Error(
    `${method} ${path} failed (${response.status}${detail ? ` ${detail}` : ""})`,
  );
}

function requestMethod(init: RequestInit | undefined): string {
  return (init?.method ?? "GET").toUpperCase();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function socketUrl(baseUrl: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/live/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function responseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return headers;
}

function uploadWithXhr(
  XMLHttpRequestImpl: typeof globalThis.XMLHttpRequest,
  url: string,
  init: RequestInit,
  onProgress: (progress: LfgUploadProgress) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequestImpl();
    const signal = init.signal;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => request.abort();

    request.open(requestMethod(init), url, true);
    for (const [name, value] of new Headers(init.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      onProgress({
        loaded: event.loaded,
        total: event.total,
        lengthComputable: event.lengthComputable,
      });
    });
    request.addEventListener("load", () => {
      finish(() => {
        resolve(
          new Response(request.responseText, {
            status: request.status,
            statusText: request.statusText,
            headers: responseHeaders(request.getAllResponseHeaders()),
          }),
        );
      });
    });
    request.addEventListener("error", () => {
      finish(() => reject(new Error("Upload failed due to a network error")));
    });
    request.addEventListener("abort", () => {
      finish(() => reject(new DOMException("Upload cancelled", "AbortError")));
    });

    if (signal?.aborted) {
      finish(() => reject(new DOMException("Upload cancelled", "AbortError")));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.send(init.body as XMLHttpRequestBodyInit | Document | null | undefined);
  });
}

export function createSameOriginTransport(
  input: {
    fetch?: typeof globalThis.fetch;
    WebSocket?: typeof globalThis.WebSocket;
    XMLHttpRequest?: typeof globalThis.XMLHttpRequest;
  } = {},
): LfgTransport {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const WebSocketImpl = input.WebSocket ?? globalThis.WebSocket;
  const XMLHttpRequestImpl = input.XMLHttpRequest ?? globalThis.XMLHttpRequest;
  return {
    fetch(path: string, init?: RequestInit): Promise<Response> {
      return fetchImpl(path, init);
    },
    ...(XMLHttpRequestImpl
      ? {
          upload(
            path: string,
            init: RequestInit,
            onProgress: (progress: LfgUploadProgress) => void,
          ): Promise<Response> {
            return uploadWithXhr(XMLHttpRequestImpl, path, init, onProgress);
          },
        }
      : {}),
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await fetchImpl(path, init);
      const { data, text } = await readBody(response);
      if (!response.ok) throw apiError(response, requestMethod(init), path, data, text);
      return data as T;
    },
    async openLiveSocket(): Promise<LfgSocket> {
      const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocketImpl(`${protocol}//${globalThis.location.host}/api/live/ws`) as LfgSocket;
    },
  };
}

export function createGrantTransport(options: CreateGrantTransportOptions): LfgTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const WebSocketImpl = options.WebSocket ?? globalThis.WebSocket;
  const XMLHttpRequestImpl = options.XMLHttpRequest ?? globalThis.XMLHttpRequest;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  let cached: LfgGrant | null = null;

  const grant = async (forceRefresh = false) => {
    if (
      !forceRefresh &&
      cached &&
      cached.expiresAt - Date.now() > GRANT_REFRESH_SKEW_MS
    ) {
      return cached;
    }
    cached = await options.getGrant({ forceRefresh });
    return cached;
  };

  const authenticatedFetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const execute = async (forceRefresh: boolean) => {
      const current = await grant(forceRefresh);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${current.token}`);
      return fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers,
        mode: "cors",
        credentials: "omit",
      });
    };
    let response = await execute(false);
    if (response.status === 401) response = await execute(true);
    return response;
  };

  const authenticatedUpload = XMLHttpRequestImpl
    ? async (
        path: string,
        init: RequestInit,
        onProgress: (progress: LfgUploadProgress) => void,
      ): Promise<Response> => {
        const execute = async (forceRefresh: boolean) => {
          const current = await grant(forceRefresh);
          const headers = new Headers(init.headers);
          headers.set("Authorization", `Bearer ${current.token}`);
          return uploadWithXhr(
            XMLHttpRequestImpl,
            `${baseUrl}${path}`,
            { ...init, headers },
            onProgress,
          );
        };
        let response = await execute(false);
        if (response.status === 401) response = await execute(true);
        return response;
      }
    : null;

  return {
    fetch: authenticatedFetch,
    ...(authenticatedUpload ? { upload: authenticatedUpload } : {}),
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await authenticatedFetch(path, init);
      const { data, text } = await readBody(response);
      if (!response.ok) throw apiError(response, requestMethod(init), path, data, text);
      return data as T;
    },
    async openLiveSocket(): Promise<LfgSocket> {
      const current = await grant(false);
      return new WebSocketImpl(
        socketUrl(baseUrl),
        [`lfg-bearer.${current.token}`],
      ) as LfgSocket;
    },
  };
}

export type LfgConnectionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "offline";

export interface LfgConnectionState {
  status: LfgConnectionStatus;
  attempt: number;
}

type TranscriptListener = (event: LfgTranscriptEvent) => void;
type ConnectionListener = (state: LfgConnectionState) => void;

function channelId(channel: LfgLiveChannel): string {
  return `${channel.kind}:${channel.key}`;
}

export class LfgLiveConnection {
  private socket: LfgSocket | null = null;
  private disposed = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private listeners = new Map<string, Set<TranscriptListener>>();
  private cursors = new Map<string, number>();
  private sentChannels = new Set<string>();
  private pendingFlush = false;
  private connectionListeners = new Set<ConnectionListener>();
  private connectionState: LfgConnectionState = {
    status: "connecting",
    attempt: 0,
  };

  constructor(private readonly transport: LfgTransport) {}

  get state(): LfgConnectionState {
    return this.connectionState;
  }

  subscribeConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => this.connectionListeners.delete(listener);
  }

  subscribeTranscript(sessionId: string, listener: TranscriptListener): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set<TranscriptListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    this.ensureConnected();
    this.scheduleSubscriptionFlush();
    return () => {
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size) return;
      this.listeners.delete(sessionId);
      this.cursors.delete(channelId({ kind: "transcript", key: sessionId }));
      if (this.sentChannels.delete(sessionId)) {
        this.send({
          t: "unsubscribe",
          channels: [{ kind: "transcript", key: sessionId }],
        });
      }
      if (!this.listeners.size) this.closeSocket();
    };
  }

  reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closeSocket(false);
    this.ensureConnected();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.connectionListeners.clear();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeSocket();
  }

  private publishConnection(state: LfgConnectionState): void {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener(state);
  }

  private ensureConnected(): void {
    if (
      this.disposed ||
      this.connecting ||
      !this.listeners.size ||
      (this.socket && (this.socket.readyState === 0 || this.socket.readyState === SOCKET_OPEN))
    ) {
      return;
    }
    this.connecting = true;
    this.publishConnection({
      status: this.reconnectAttempt ? "reconnecting" : "connecting",
      attempt: this.reconnectAttempt,
    });
    void this.transport.openLiveSocket().then(
      (socket) => {
        if (this.disposed || !this.listeners.size) {
          socket.close();
          this.connecting = false;
          return;
        }
        this.socket = socket;
        this.connecting = false;
        socket.addEventListener("open", () => {
          if (this.socket !== socket) return;
          this.reconnectAttempt = 0;
          this.sentChannels.clear();
          this.publishConnection({ status: "live", attempt: 0 });
          this.scheduleSubscriptionFlush();
        });
        socket.addEventListener("message", (event) => {
          if (this.socket !== socket || typeof event.data !== "string") return;
          try {
            this.handleMessage(JSON.parse(event.data) as LfgLiveMessage);
          } catch {
            // A malformed frame is isolated to that frame.
          }
        });
        socket.addEventListener("close", () => {
          if (this.socket !== socket) return;
          this.socket = null;
          this.sentChannels.clear();
          this.scheduleReconnect();
        });
        socket.addEventListener("error", () => {
          if (this.socket === socket) socket.close();
        });
      },
      () => {
        this.connecting = false;
        this.scheduleReconnect();
      },
    );
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.listeners.size || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.publishConnection({
      status: this.reconnectAttempt >= 5 ? "offline" : "reconnecting",
      attempt: this.reconnectAttempt,
    });
    const delay = Math.min(8_000, 250 * 2 ** Math.min(5, this.reconnectAttempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
  }

  private closeSocket(markDisposed = true): void {
    const socket = this.socket;
    this.socket = null;
    this.sentChannels.clear();
    if (socket) socket.close(markDisposed ? 1000 : 4000, "client transition");
  }

  private scheduleSubscriptionFlush(): void {
    if (this.pendingFlush) return;
    this.pendingFlush = true;
    queueMicrotask(() => {
      this.pendingFlush = false;
      if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
      const channels: LfgLiveChannel[] = [];
      for (const sessionId of this.listeners.keys()) {
        if (this.sentChannels.has(sessionId)) continue;
        const channel: LfgLiveChannel = { kind: "transcript", key: sessionId };
        const cursor = this.cursors.get(channelId(channel));
        if (cursor) channel.resumeFromSeq = cursor;
        channels.push(channel);
        this.sentChannels.add(sessionId);
      }
      if (channels.length) this.send({ t: "subscribe", channels });
    });
  }

  private send(payload: unknown): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  private emit(sessionId: string, event: LfgTranscriptEvent): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }

  private handleMessage(message: LfgLiveMessage): void {
    if (message.t === "ping") {
      this.send({ t: "pong", ...(message.id ? { id: message.id } : {}) });
      return;
    }
    if (
      "kind" in message &&
      message.kind === "transcript" &&
      "key" in message &&
      typeof message.key === "string"
    ) {
      const id = channelId({ kind: message.kind, key: message.key });
      if (typeof message.seq === "number") {
        const previous = this.cursors.get(id) ?? 0;
        const resync =
          message.t === "snapshot" ||
          message.t === "gap" ||
          message.t === "resumed";
        if (!resync && message.seq <= previous) return;
        this.cursors.set(id, message.seq);
      }
      if (message.t === "snapshot") {
        this.emit(message.key, {
          type: "snapshot",
          messages: message.messages ?? [],
          nextBefore: message.nextBefore ?? null,
        });
        return;
      }
      if (message.t === "delta" && message.delta?.t) {
        this.handleMessage({
          ...message.delta,
          t: message.delta.t,
          sid: message.delta.sid ?? message.key,
        } as LfgLiveMessage);
        return;
      }
      if (message.t === "error") {
        this.emit(message.key, {
          type: "error",
          error: message.message ?? message.code ?? "Live connection error",
        });
      }
      return;
    }
    const sessionId = "sid" in message ? message.sid : undefined;
    if (!sessionId) return;
    if (message.t === "batch") {
      this.emit(sessionId, {
        type: "snapshot",
        messages: message.messages ?? [],
        nextBefore: message.nextBefore ?? null,
      });
    } else if (message.t === "msg") {
      const item = message.message ?? message.m;
      if (item) this.emit(sessionId, { type: "message", message: item });
    } else if (message.t === "ai_part" && message.part) {
      this.emit(sessionId, { type: "ai_part", part: message.part });
    } else if (message.t === "busy") {
      this.emit(sessionId, { type: "busy", busy: !!message.busy });
    } else if (message.t === "prompt") {
      this.emit(sessionId, {
        type: "prompt",
        prompt: message.prompt ?? null,
      });
    } else if (message.t === "error") {
      this.emit(sessionId, {
        type: "error",
        error: message.message ?? message.code ?? "Live connection error",
      });
    }
  }
}

export class LfgClient {
  readonly live: LfgLiveConnection;
  private sessions: LfgSession[] | null = null;

  constructor(readonly transport: LfgTransport) {
    this.live = new LfgLiveConnection(transport);
  }

  peekSessions(): LfgSession[] | null {
    return this.sessions;
  }

  async listSessions(): Promise<LfgSession[]> {
    const response = await this.transport.request<LfgSessionsResponse>("/api/sessions", {
      cache: "no-store",
    });
    this.sessions = Array.isArray(response.sessions) ? response.sessions : [];
    return this.sessions;
  }

  async getMessages(sessionId: string, limit = 80): Promise<LfgMessagesResponse> {
    return this.transport.request<LfgMessagesResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
      { cache: "no-store" },
    );
  }

  async sendMessage(sessionId: string, text: string): Promise<LfgSendResponse> {
    return this.transport.request<LfgSendResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.transport.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      { method: "POST" },
    );
  }

  dispose(): void {
    this.live.dispose();
  }
}
