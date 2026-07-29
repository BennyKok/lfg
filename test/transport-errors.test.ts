// A failed request has to say what failed. lfg's own routes answer with
// { error } and that copy goes straight to the user, but anything between the
// browser and lfg — the omg session proxy, an edge, a tunnel — answers with
// plain text or nothing at all. That case used to render as `${status}
// ${statusText}`, and HTTP/2 never sends statusText, so a real failure reached
// the session error line as a naked "405" that cost an afternoon to trace.

import { expect, test } from "bun:test";

import { createGrantTransport, createSameOriginTransport } from "../packages/client/src/index.ts";

function respondWith(
  body: string,
  init: ResponseInit & { statusText?: string },
): typeof globalThis.fetch {
  return (async () => new Response(body, init)) as unknown as typeof globalThis.fetch;
}

const grant = { token: "t", expiresAt: Date.now() + 3_600_000 };

test("an lfg { error } body is passed through untouched", async () => {
  const transport = createSameOriginTransport({
    fetch: respondWith(JSON.stringify({ error: "method not allowed" }), { status: 405 }),
  });

  expect(transport.request("/api/agents", { method: "PUT" })).rejects.toThrow(
    "method not allowed",
  );
});

test("a plain-text failure names the request instead of a bare status", async () => {
  const transport = createSameOriginTransport({
    // HTTP/2 always reports an empty statusText — the exact shape that used to
    // collapse to "405 ".
    fetch: respondWith("method not allowed", { status: 405, statusText: "" }),
  });

  let message = "";
  try {
    await transport.request("/api/sessions/abc/message", { method: "POST" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).not.toBe("405 ");
  expect(message).toContain("405");
  expect(message).toContain("POST");
  expect(message).toContain("/api/sessions/abc/message");
  expect(message).toContain("method not allowed");
});

test("an empty body still identifies the request and status", async () => {
  const transport = createSameOriginTransport({
    fetch: respondWith("", { status: 502, statusText: "" }),
  });

  let message = "";
  try {
    await transport.request("/api/bootstrap");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  // No body and no statusText: the method, path and status are all we have, and
  // all three have to survive.
  expect(message).toContain("GET");
  expect(message).toContain("/api/bootstrap");
  expect(message).toContain("502");
});

test("the grant transport reports the same way as the same-origin one", async () => {
  const transport = createGrantTransport({
    baseUrl: "https://sessions.omgs.app",
    getGrant: async () => grant,
    fetch: respondWith("<html>Method Not Allowed</html>", { status: 405, statusText: "" }),
  });

  let message = "";
  try {
    await transport.request("/api/sessions/abc", { method: "DELETE" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toContain("DELETE");
  expect(message).toContain("/api/sessions/abc");
  expect(message).toContain("405");
});

test("a successful JSON response is still returned as data", async () => {
  const transport = createSameOriginTransport({
    fetch: respondWith(JSON.stringify({ sessions: [] }), { status: 200 }),
  });

  expect(await transport.request("/api/sessions")).toEqual({ sessions: [] });
});
