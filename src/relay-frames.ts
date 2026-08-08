// Binary frame codec for the box ⇄ relay tunnel.
//
// ⚠️ MIRROR of the vibes repo's `apps/relay/src/frames.ts`. The two files
// implement one wire format and must be changed together — a relay built
// against a different layout does not fail loudly, it silently loses frames.
// The format is versioned only through capability negotiation (see BOX_CAPS):
// this client never sends a binary frame unless the relay answered `hello` /
// `pair` advertising that it understands them, so an old relay keeps working
// against a new box and vice versa.
//
// WHY IT EXISTS. The original protocol was JSON-only, which meant every byte
// of a proxied HTTP body or live-tunnel message had to be base64'd into a JSON
// string. That costs a 4/3 size inflation plus an encode and a decode at each
// hop — and it is what pushed a 26 MB video artifact past the relay's
// WebSocket frame ceiling, where an oversized frame does not fail politely: it
// closes this box's connection. Raw bytes ride a binary frame now.
//
// LAYOUT
//   [4 bytes  big-endian uint32 : header length N]
//   [N bytes  UTF-8 JSON        : the frame header, same shape as the text
//                                 frame it replaces, minus the base64 field]
//   [rest     raw bytes         : the payload]

/** Cap on the JSON header so a malformed length can't drive a huge allocation.
 *  Headers are a type, an id, and a few short fields — kilobytes at most. */
const MAX_HEADER_BYTES = 1024 * 1024;

/** Raw bytes instead of base64 for payload-carrying frames. */
export const CAP_BINARY = "binary";
/** http-head / http-body / http-end instead of one buffered http-response. */
export const CAP_HTTP_STREAM = "http-stream";

/** Everything this box build understands. The relay answers with the subset it
 *  also supports, and that intersection is what the connection uses. */
export const BOX_CAPS: readonly string[] = [CAP_BINARY, CAP_HTTP_STREAM];

export type BinaryFrame = { header: Record<string, unknown>; payload: Uint8Array };

export function encodeBinaryFrame(
  header: Record<string, unknown>,
  payload: Uint8Array,
): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + payload.length);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, 4);
  out.set(payload, 4 + head.length);
  return out;
}

/** Decode, or null if this isn't a well-formed binary frame — callers treat
 *  null as "not for me" and fall through to the text-JSON path rather than
 *  dropping the connection over one bad frame. */
export function decodeBinaryFrame(data: Uint8Array): BinaryFrame | null {
  if (data.length < 4) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(0, false);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) return null;
  if (4 + headerLength > data.length) return null;
  try {
    const header = JSON.parse(
      new TextDecoder().decode(data.subarray(4, 4 + headerLength)),
    ) as Record<string, unknown>;
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    if (typeof header.type !== "string") return null;
    return { header, payload: data.subarray(4 + headerLength) };
  } catch {
    return null;
  }
}

/** The caps both ends understand, order-stable and deduped. */
export function negotiateCaps(
  advertised: unknown,
  supported: readonly string[] = BOX_CAPS,
): string[] {
  if (!Array.isArray(advertised)) return [];
  const offered = new Set(advertised.filter((c): c is string => typeof c === "string"));
  return supported.filter((cap) => offered.has(cap));
}
