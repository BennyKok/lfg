// The shared, in-process MCP endpoint.
//
// OMG used to register its MCP server with every coding agent as a *stdio*
// server, so each agent CLI spawned its own `bun src/cli.ts mcp` child. On a
// box running 14 sessions that was 14 identical Bun processes costing ~38 MB of
// anonymous memory each — ~540 MB — whose only job was to translate MCP calls
// into HTTP calls against the `omg serve` process already running beside them.
//
// The MCP server holds no state (see buildOmgMcpServer: every tool is a proxied
// HTTP call to this same process), so the serve process can answer every agent
// itself. Agents whose CLI can register an HTTP MCP server are pointed here
// instead, and the per-session processes disappear.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { aliasLegacyToolNames, buildOmgMcpServer, withCallerSession } from "./commands/mcp.ts";

/**
 * Which OMG session this request speaks for.
 *
 * A stdio MCP child inherits OMG_SESSION_ID from the agent that spawned it. This
 * process is shared by every session, so the caller has to say who it is: agents
 * are registered against `/mcp?session=<id>`, and a header is accepted for
 * clients that cannot carry a query string. Anonymous requests stay anonymous —
 * session-scoped tools then require an explicit sessionId argument, exactly as
 * they do outside a managed session.
 */
function callerSessionFromRequest(req: Request): string | undefined {
  const fromQuery = new URL(req.url).searchParams.get("session")?.trim();
  if (fromQuery) return fromQuery;
  // Both spellings: agents registered before the OMG rename still send the
  // x-lfg-session-id header, and dropping it would silently anonymise them —
  // which downgrades their session-scoped tools rather than failing loudly.
  return (
    req.headers.get("x-omg-session-id")?.trim() ||
    req.headers.get("x-lfg-session-id")?.trim() ||
    undefined
  );
}

/**
 * Answer one MCP request over Streamable HTTP.
 *
 * A fresh server+transport pair per request: the SDK's stateless transport
 * refuses to be reused ("Stateless transport cannot be reused across
 * requests"), and statelessness is what we want here anyway — no session
 * bookkeeping, and a crashed agent leaves nothing behind. Building the pair is
 * cheap; it registers plain closures. The expensive thing was the *process*,
 * which is what this removes.
 */
export async function serveOmgMcpRequest(req: Request): Promise<Response> {
  // Bind the caller for the whole request, so every tool handler it reaches
  // resolves the same session the agent is running as.
  return await withCallerSession(callerSessionFromRequest(req), () => answerOne(req));
}

async function answerOne(req: Request): Promise<Response> {
  const server = buildOmgMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Omitting sessionIdGenerator selects stateless mode.
    sessionIdGenerator: undefined,
    // Prefer a buffered JSON reply over an SSE frame for request/response
    // traffic, so the pair can be torn down as soon as the body is in hand.
    enableJsonResponse: true,
  });

  let response: Response;
  try {
    await server.connect(transport);
    // After connect, so the server's own handler is the one being wrapped.
    aliasLegacyToolNames(transport as unknown as { onmessage?: (m: unknown, e?: unknown) => void });
    response = await transport.handleRequest(req);
  } catch (e) {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
    throw e;
  }

  // A streaming reply (server-initiated SSE) owns the transport for as long as
  // the stream is open — closing here would truncate it. Hand it back untouched
  // and let the stream's own completion tear it down.
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }

  // Otherwise the body is already complete. Read it out before closing, so the
  // teardown cannot race a body the client has not received yet.
  const body = await response.arrayBuffer();
  void transport.close().catch(() => {});
  void server.close().catch(() => {});
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
