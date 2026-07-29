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

export interface LfgTransport {
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
}

const SOCKET_OPEN = 1;
const GRANT_REFRESH_SKEW_MS = 30_000;

function apiError(status: number, statusText: string, data: unknown): Error {
  const message =
    data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error
      : `${status} ${statusText}`;
  return new Error(message);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function socketUrl(baseUrl: string): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/live/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createSameOriginTransport(
  input: {
    fetch?: typeof globalThis.fetch;
    WebSocket?: typeof globalThis.WebSocket;
  } = {},
): LfgTransport {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const WebSocketImpl = input.WebSocket ?? globalThis.WebSocket;
  return {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await fetchImpl(path, init);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw apiError(response.status, response.statusText, data);
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

  return {
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const execute = async (forceRefresh: boolean) => {
        const current = await grant(forceRefresh);
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${current.token}`);
        const response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers,
          mode: "cors",
          credentials: "omit",
        });
        return response;
      };
      let response = await execute(false);
      if (response.status === 401) response = await execute(true);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw apiError(response.status, response.statusText, data);
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
