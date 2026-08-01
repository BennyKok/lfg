// The shared, in-process MCP endpoint.
//
// LFG used to register its MCP server with every coding agent as a *stdio*
// server, so each agent CLI spawned its own `bun src/cli.ts mcp` child. On a
// box running 14 sessions that was 14 identical Bun processes costing ~38 MB of
// anonymous memory each — ~540 MB — whose only job was to translate MCP calls
// into HTTP calls against the `lfg serve` process already running beside them.
//
// The MCP server holds no state (see buildLfgMcpServer: every tool is a proxied
// HTTP call to this same process), so the serve process can answer every agent
// itself. Agents whose CLI can register an HTTP MCP server are pointed here
// instead, and the per-session processes disappear.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildLfgMcpServer } from "./commands/mcp.ts";

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
export async function serveLfgMcpRequest(req: Request): Promise<Response> {
  const server = buildLfgMcpServer();
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
