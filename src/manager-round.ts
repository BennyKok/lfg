import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeOauthToken } from "./claude-creds.ts";

export const MANAGER_PROTOCOL = "lfg.manager.v1" as const;
export const DEFAULT_MANAGER_MODEL = "claude-haiku-4-5";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_MESSAGES = 64;
const MAX_TOOLS = 64;
const MAX_BODY_CHARS = 1_000_000;

type JsonObject = Record<string, unknown>;

export type ManagerRoundRequest = {
  protocol: typeof MANAGER_PROTOCOL;
  managerId: string;
  turnId: string;
  round: number;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: unknown }>;
  tools: Array<{
    name: string;
    description?: string;
    input_schema: JsonObject;
  }>;
  maxTokens?: number;
};

export type ManagerRoundResponse = {
  protocol: typeof MANAGER_PROTOCOL;
  managerId: string;
  turnId: string;
  round: number;
  model: string;
  stopReason: string | null;
  content: JsonObject[];
};

export class ManagerRoundError extends Error {
  constructor(
    public readonly status: 400 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ManagerRoundError";
  }
}

type ManagerRoundDependencies = {
  dataDir: string;
  token?: () => string | null;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  model?: string;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  min: number,
  max: number,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    (pattern && !pattern.test(value))
  ) {
    throw new ManagerRoundError(400, `invalid ${field}`);
  }
  return value;
}

function assertJsonValue(value: unknown, field: string): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ManagerRoundError(400, `invalid ${field}`);
  }
  if (encoded === undefined || encoded.length > MAX_BODY_CHARS) {
    throw new ManagerRoundError(400, `invalid ${field}`);
  }
}

export function parseManagerRoundRequest(value: unknown): ManagerRoundRequest {
  if (!isObject(value)) throw new ManagerRoundError(400, "invalid request");
  if (value.protocol !== MANAGER_PROTOCOL) {
    throw new ManagerRoundError(400, "unsupported manager protocol");
  }

  const managerId = boundedString(
    value.managerId,
    "managerId",
    1,
    96,
    /^[A-Za-z0-9:_-]+$/,
  );
  const turnId = boundedString(
    value.turnId,
    "turnId",
    8,
    128,
    /^[A-Za-z0-9:_-]+$/,
  );
  if (!Number.isInteger(value.round) || (value.round as number) < 0 || (value.round as number) > 12) {
    throw new ManagerRoundError(400, "invalid round");
  }
  const system = boundedString(value.system, "system", 1, 200_000);

  if (!Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) {
    throw new ManagerRoundError(400, "invalid messages");
  }
  const messages = value.messages.map((message, index) => {
    if (!isObject(message) || (message.role !== "user" && message.role !== "assistant")) {
      throw new ManagerRoundError(400, `invalid messages[${index}]`);
    }
    assertJsonValue(message.content, `messages[${index}].content`);
    return {
      role: message.role as "user" | "assistant",
      content: message.content,
    };
  });

  if (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS) {
    throw new ManagerRoundError(400, "invalid tools");
  }
  const names = new Set<string>();
  const tools = value.tools.map((tool, index) => {
    if (!isObject(tool) || !isObject(tool.input_schema)) {
      throw new ManagerRoundError(400, `invalid tools[${index}]`);
    }
    const name = boundedString(tool.name, `tools[${index}].name`, 1, 128, /^[A-Za-z0-9_-]+$/);
    if (names.has(name)) throw new ManagerRoundError(400, "duplicate tool name");
    names.add(name);
    const description =
      tool.description === undefined
        ? undefined
        : boundedString(tool.description, `tools[${index}].description`, 0, 20_000);
    assertJsonValue(tool.input_schema, `tools[${index}].input_schema`);
    return { name, description, input_schema: tool.input_schema };
  });

  const maxTokens =
    value.maxTokens === undefined
      ? undefined
      : Number.isInteger(value.maxTokens) &&
          (value.maxTokens as number) >= 1 &&
          (value.maxTokens as number) <= 8192
        ? (value.maxTokens as number)
        : (() => {
            throw new ManagerRoundError(400, "invalid maxTokens");
          })();

  return {
    protocol: MANAGER_PROTOCOL,
    managerId,
    turnId,
    round: value.round as number,
    system,
    messages,
    tools,
    maxTokens,
  };
}

function cachePart(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validResponse(value: unknown): value is ManagerRoundResponse {
  if (!isObject(value) || value.protocol !== MANAGER_PROTOCOL || !Array.isArray(value.content)) {
    return false;
  }
  return value.content.every(isObject);
}

export function createManagerRoundService(deps: ManagerRoundDependencies) {
  const token = deps.token ?? claudeOauthToken;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const model = deps.model ?? process.env.LFG_MANAGER_MODEL ?? DEFAULT_MANAGER_MODEL;
  const inFlight = new Map<string, Promise<ManagerRoundResponse>>();

  function capabilities() {
    const available = Boolean(token());
    return {
      protocol: MANAGER_PROTOCOL,
      available,
      model,
      reason: available ? null : "claude_oauth_unavailable",
    };
  }

  async function runUncached(request: ManagerRoundRequest): Promise<ManagerRoundResponse> {
    const oauthToken = token();
    if (!oauthToken) {
      throw new ManagerRoundError(503, "local AI is not signed in");
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${oauthToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: request.maxTokens ?? 2048,
          system: request.system,
          messages: request.messages,
          ...(request.tools.length ? { tools: request.tools } : {}),
        }),
      });
    } catch {
      throw new ManagerRoundError(502, "local AI request failed");
    }
    if (!upstream.ok) {
      throw new ManagerRoundError(502, `local AI returned HTTP ${upstream.status}`);
    }

    const body = (await upstream.json().catch(() => null)) as JsonObject | null;
    if (
      !body ||
      !Array.isArray(body.content) ||
      !body.content.every(isObject) ||
      (body.stop_reason !== null && body.stop_reason !== undefined && typeof body.stop_reason !== "string")
    ) {
      throw new ManagerRoundError(502, "local AI returned an invalid response");
    }
    return {
      protocol: MANAGER_PROTOCOL,
      managerId: request.managerId,
      turnId: request.turnId,
      round: request.round,
      model,
      stopReason: (body.stop_reason as string | null | undefined) ?? null,
      content: body.content,
    };
  }

  async function run(raw: unknown): Promise<ManagerRoundResponse> {
    const request = parseManagerRoundRequest(raw);
    const managerDir = join(deps.dataDir, "manager-rounds", cachePart(request.managerId));
    const cachePath = join(managerDir, `${cachePart(`${request.turnId}:${request.round}`)}.json`);
    const key = cachePath;

    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as unknown;
      if (validResponse(cached)) return cached;
    } catch {}

    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = (async () => {
      const response = await runUncached(request);
      await mkdir(managerDir, { recursive: true });
      const tempPath = `${cachePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tempPath, JSON.stringify(response), { mode: 0o600 });
      await rename(tempPath, cachePath);
      return response;
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return { capabilities, run };
}
