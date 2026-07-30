import { expect, test } from "bun:test";
import {
  LfgLiveConnection,
  createGrantTransport,
  createSameOriginTransport,
  type LfgSocket,
  type LfgTransport,
} from "./index";

class FakeSocket implements LfgSocket {
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Set<(event?: never) => void>>();

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: never) => void) {
    const current = this.listeners.get(type) ?? new Set();
    current.add(listener);
    this.listeners.set(type, current);
  }

  open() {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener();
  }
}

class FakeUploadTarget {
  private progressListener: ((event: {
    loaded: number;
    total: number;
    lengthComputable: boolean;
  }) => void) | null = null;

  addEventListener(
    type: string,
    listener: (event: {
      loaded: number;
      total: number;
      lengthComputable: boolean;
    }) => void,
  ) {
    if (type === "progress") this.progressListener = listener;
  }

  emit(loaded: number, total: number) {
    this.progressListener?.({ loaded, total, lengthComputable: true });
  }
}

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];
  static statuses: number[] = [];
  upload = new FakeUploadTarget();
  status = 200;
  statusText = "OK";
  responseText = JSON.stringify({ ok: true });
  method = "";
  url = "";
  headers = new Headers();
  body: unknown;
  private listeners = new Map<string, () => void>();

  constructor() {
    this.status = FakeXMLHttpRequest.statuses.shift() ?? 200;
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }

  getAllResponseHeaders() {
    return "content-type: application/json\r\n";
  }

  send(body: unknown) {
    this.body = body;
    this.upload.emit(3, 10);
    this.upload.emit(8, 10);
    queueMicrotask(() => this.listeners.get("load")?.());
  }

  abort() {
    this.listeners.get("abort")?.();
  }
}

test("many transcript subscriptions share one socket and one batched subscribe frame", async () => {
  const socket = new FakeSocket();
  let opens = 0;
  const transport: LfgTransport = {
    fetch: async () => new Response(),
    request: async () => ({}) as never,
    openLiveSocket: async () => {
      opens += 1;
      return socket;
    },
  };
  const live = new LfgLiveConnection(transport);
  const offA = live.subscribeTranscript("a", () => {});
  const offB = live.subscribeTranscript("b", () => {});
  await Promise.resolve();
  socket.open();
  await Promise.resolve();

  expect(opens).toBe(1);
  expect(socket.sent).toHaveLength(1);
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    t: "subscribe",
    channels: [
      { kind: "transcript", key: "a" },
      { kind: "transcript", key: "b" },
    ],
  });

  offA();
  offB();
  live.dispose();
});

test("same-origin uploads expose byte progress", async () => {
  FakeXMLHttpRequest.instances = [];
  FakeXMLHttpRequest.statuses = [];
  const transport = createSameOriginTransport({
    XMLHttpRequest: FakeXMLHttpRequest as unknown as typeof XMLHttpRequest,
  });
  const progress: number[] = [];

  const response = await transport.upload!(
    "/api/uploads",
    { method: "POST", body: new Blob(["0123456789"]) },
    (event) => progress.push(event.loaded),
  );

  expect(await response.json()).toEqual({ ok: true });
  expect(progress).toEqual([3, 8]);
  expect(FakeXMLHttpRequest.instances[0]!.method).toBe("POST");
  expect(FakeXMLHttpRequest.instances[0]!.url).toBe("/api/uploads");
});

test("grant uploads preserve the authenticated runtime boundary", async () => {
  FakeXMLHttpRequest.instances = [];
  FakeXMLHttpRequest.statuses = [401, 200];
  const grants: string[] = [];
  const transport = createGrantTransport({
    baseUrl: "https://sessions.example",
    getGrant: async ({ forceRefresh }) => {
      const token = forceRefresh ? "fresh-upload-token" : "upload-token";
      grants.push(token);
      return {
        token,
        expiresAt: Date.now() + 60_000,
      };
    },
    XMLHttpRequest: FakeXMLHttpRequest as unknown as typeof XMLHttpRequest,
    WebSocket: class {} as typeof WebSocket,
  });

  await transport.upload!(
    "/api/uploads",
    { method: "POST", body: new Blob(["bytes"]) },
    () => {},
  );

  expect(FakeXMLHttpRequest.instances).toHaveLength(2);
  expect(grants).toEqual(["upload-token", "fresh-upload-token"]);
  expect(FakeXMLHttpRequest.instances[0]!.url).toBe(
    "https://sessions.example/api/uploads",
  );
  expect(FakeXMLHttpRequest.instances[0]!.headers.get("Authorization")).toBe(
    "Bearer upload-token",
  );
  expect(FakeXMLHttpRequest.instances[1]!.headers.get("Authorization")).toBe(
    "Bearer fresh-upload-token",
  );
});

test("raw package fetch shares bearer auth and refreshes once on 401", async () => {
  const grants: string[] = [];
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const transport = createGrantTransport({
    baseUrl: "https://sessions.example",
    getGrant: async ({ forceRefresh }) => {
      const token = forceRefresh ? "fresh" : "initial";
      grants.push(token);
      return { token, expiresAt: Date.now() + 60_000 };
    },
    fetch: (async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("Authorization"),
      });
      return new Response("stream", {
        status: requests.length === 1 ? 401 : 200,
      });
    }) as typeof fetch,
    WebSocket: class {} as typeof WebSocket,
  });

  const response = await transport.fetch("/api/bootstrap");

  expect(await response.text()).toBe("stream");
  expect(grants).toEqual(["initial", "fresh"]);
  expect(requests).toEqual([
    {
      url: "https://sessions.example/api/bootstrap",
      authorization: "Bearer initial",
    },
    {
      url: "https://sessions.example/api/bootstrap",
      authorization: "Bearer fresh",
    },
  ]);
});
