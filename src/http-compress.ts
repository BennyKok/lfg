import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

type CompressionEncoding = "br" | "gzip";
type HeaderSource = Headers | Record<string, string> | Array<[string, string]>;

const DYNAMIC_MIN_BYTES = 1024;
const PRECOMPRESSED_ASSET_SKIP_EXTENSIONS = new Set([
  ".avif",
  ".br",
  ".gif",
  ".gz",
  ".ico",
  ".jpg",
  ".jpeg",
  ".map",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

function isPrecompressedAssetCandidate(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of PRECOMPRESSED_ASSET_SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return false;
  }
  return true;
}

function acceptedEncodings(req: Request): CompressionEncoding[] {
  const raw = req.headers.get("accept-encoding") ?? "";
  const accepted = new Set<string>();
  for (const part of raw.split(",")) {
    const [nameRaw, ...params] = part.trim().split(";");
    const name = nameRaw.trim().toLowerCase();
    if (!name) continue;
    const q = params
      .map((p) => p.trim().match(/^q=([0-9.]+)$/i)?.[1])
      .find((v): v is string => !!v);
    if (q !== undefined && Number(q) <= 0) continue;
    accepted.add(name);
  }
  const out: CompressionEncoding[] = [];
  if (accepted.has("br") || accepted.has("*")) out.push("br");
  if (accepted.has("gzip") || accepted.has("*")) out.push("gzip");
  return out;
}

function addAcceptEncodingVary(headers: Headers) {
  const vary = headers.get("vary");
  if (!vary) {
    headers.set("Vary", "Accept-Encoding");
    return;
  }
  if (vary.split(",").some((v) => v.trim().toLowerCase() === "accept-encoding")) return;
  headers.set("Vary", `${vary}, Accept-Encoding`);
}

function compressBody(body: Uint8Array, encoding: CompressionEncoding): Uint8Array {
  if (encoding === "br") {
    return brotliCompressSync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      },
    });
  }
  return gzipSync(body, { level: 6 });
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return /\bapplication\/(?:[^;\s]+\+)?json\b/.test(contentType);
}

function shouldSkipDynamicCompression(req: Request, path: string, response: Response): boolean {
  if (req.method === "HEAD") return true;
  if (!path.startsWith("/api/")) return true;
  if (path.startsWith("/api/live/")) return true;
  if (req.headers.has("range")) return true;
  if (req.headers.get("upgrade")) return true;
  if (response.status === 204 || response.status === 304) return true;
  if (response.headers.has("content-encoding")) return true;
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) return true;
  if (!isJsonResponse(response)) return true;
  return false;
}

function responseInit(response: Response, headers: Headers): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
}

export async function compressedAssetResponse(
  req: Request,
  filePath: string,
  headersInit: HeaderSource,
): Promise<Response | null> {
  if (req.method === "HEAD" || req.headers.has("range")) return null;
  if (!isPrecompressedAssetCandidate(filePath)) return null;
  const headers = new Headers(headersInit);
  addAcceptEncodingVary(headers);
  for (const encoding of acceptedEncodings(req)) {
    const compressedPath = `${filePath}.${encoding === "br" ? "br" : "gz"}`;
    const file = Bun.file(compressedPath);
    if (!(await file.exists())) continue;
    headers.set("Content-Encoding", encoding);
    headers.set("Content-Length", String(file.size));
    return new Response(file, { headers });
  }
  return null;
}

export async function maybeCompressResponse(
  req: Request,
  path: string,
  response: Response | undefined,
): Promise<Response | undefined> {
  if (!response) return response;
  if (shouldSkipDynamicCompression(req, path, response)) return response;
  const [encoding] = acceptedEncodings(req);
  if (!encoding) return response;

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength < DYNAMIC_MIN_BYTES) {
    return new Response(body, responseInit(response, new Headers(response.headers)));
  }

  const headers = new Headers(response.headers);
  const compressed = compressBody(body, encoding);
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(compressed.byteLength));
  addAcceptEncodingVary(headers);
  return new Response(compressed, responseInit(response, headers));
}
