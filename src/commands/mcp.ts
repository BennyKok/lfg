import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  MODEL_OPTIONS,
  listModelCatalog,
  thinkingLevelsForAgent,
} from "../agent-catalog.ts";
import { localServeBaseUrl } from "../config.ts";
import {
  LFG_CAPABILITIES,
  LFG_CAPABILITY_VERSION,
  LFG_MCP_INSTRUCTIONS,
  SHORT_SESSION_ID_LENGTH,
} from "../lfg-capabilities.ts";
import { shippedCloseDecision } from "../shipped-lifecycle.ts";

type Repo = { name: string; cwd: string; project?: string };
type SessionRow = {
  sessionId: string | null;
  nativeSessionId?: string | null;
  title?: string | null;
  agent?: string;
  model?: string | null;
  project?: string;
  parentSessionId?: string | null;
  parentNativeSessionId?: string | null;
  parentAgent?: string | null;
  spawnedBy?: string | null;
  busy?: boolean;
  tmuxTarget?: string | null;
  cwd?: string;
  status?: string | null;
  assignedUser?: string | null;
  lastActivityAt?: number | null;
};
type SessionCreateResponse = {
  ok?: boolean;
  sessionId?: string;
  tmuxName?: string;
  cwd?: string;
  agent?: string;
  model?: string | null;
  assignedUser?: string | null;
  worktree?: string | null;
  subagentDepth?: number | null;
};
type ImageArtifactResponse = {
  ok?: boolean;
  artifact?: {
    id: string;
    url: string;
    name: string;
    caption?: string;
    alt?: string;
    width?: number;
    height?: number;
    version?: number;
    refresh?: {
      enabled: boolean;
      intervalMs: number;
      timeoutMs: number;
      status: "idle" | "running" | "success" | "error";
      lastStartedAt?: number;
      lastSuccessAt?: number;
      lastError?: string;
    };
  };
  message?: {
    url?: string;
    text?: string;
    name?: string;
  };
};
type AskQuestionResponse = {
  answer: string;
};
type OriginDeliveryResponse = {
  ok?: boolean;
  delivery?: {
    id: string;
    target: "origin";
    sessionId: string;
    text: string | null;
    media: Array<{ path: string; kind: "image" | "video"; mimeType: string }>;
    createdAt: number;
  };
};

const VERSION = "0.1.21";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${localServeBaseUrl()}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

function result(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        // Compact, not pretty-printed: indentation is pure context tax on a
        // payload only a model reads.
        text: JSON.stringify(data),
      },
    ],
  };
}

// ---- Short session ids ----------------------------------------------------
// Session ids are 36-char UUIDs minted by the underlying harnesses (claude,
// codex, ...) and are load-bearing on disk: transcript filenames, tmux command
// lines, aisdk registry files, sqlite keys, and ~27 HTTP route regexes that
// hard-code the 36-char shape. So we do NOT re-mint them. Instead we do what
// git does with commit shas: agents see and pass an 8-char PREFIX, and we
// resolve it back to the full id here, at the single boundary every
// agent-facing session id crosses.
//
// Because a short id is a genuine prefix of the real UUID, it stays compatible
// with the backend's existing prefix search and remains greppable against
// transcripts and process lines.
const FULL_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHORT_SID = /^[0-9a-fA-F]{6,32}$/;
const SHORT_SID_LEN = SHORT_SESSION_ID_LENGTH;

function shortSid(id: string | null | undefined): string | null {
  if (!id) return null;
  return FULL_UUID.test(id) ? id.slice(0, SHORT_SID_LEN) : id;
}

// Short id -> full id. Only ever grows for ids we resolved from the server, so
// a stale entry is impossible: session ids are immutable.
const sidCache = new Map<string, string>();

function rememberSid(full: string | null | undefined): void {
  if (!full || !FULL_UUID.test(full)) return;
  sidCache.set(full.slice(0, SHORT_SID_LEN).toLowerCase(), full);
}

/**
 * Accept a full UUID, an 8-char short id (or any unambiguous hex prefix), or a
 * harness-native id of some other shape. Returns the id the HTTP API expects.
 * Ambiguous prefixes throw rather than silently picking a session.
 */
async function resolveSid(input: string): Promise<string> {
  const id = input.trim();
  if (!id) throw new Error("sessionId required");
  // Already full length, or not hex-prefix shaped (native codex/opencode ids):
  // pass through untouched, no network round-trip.
  if (FULL_UUID.test(id) || !SHORT_SID.test(id)) return id;

  const lower = id.toLowerCase();
  const cached = sidCache.get(lower);
  if (cached) return cached;

  const matches = new Set<string>();
  // 1. Live fleet: cheap and covers the overwhelmingly common case.
  const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
  for (const session of sessions) {
    for (const candidate of [session.sessionId, session.nativeSessionId]) {
      if (candidate?.toLowerCase().startsWith(lower)) {
        matches.add(session.sessionId ?? candidate);
      }
    }
  }
  // 2. Nothing live — fall back to durable/historical sessions.
  if (matches.size === 0) {
    const found = await api<{ sessions: Array<{ sessionId?: string | null }> }>(
      "/api/sessions/find",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, limit: 5 }),
      },
    );
    for (const session of found.sessions ?? []) {
      if (session.sessionId?.toLowerCase().startsWith(lower)) matches.add(session.sessionId);
    }
  }

  if (matches.size === 1) {
    const full = [...matches][0];
    rememberSid(full);
    return full;
  }
  if (matches.size > 1) {
    throw new Error(
      `session id "${id}" is ambiguous (matches ${matches.size} sessions); pass more characters`,
    );
  }
  throw new Error(`no session matches id "${id}"`);
}

// Agent-facing session row. The raw row carries `last` and `cmd`, which on a
// 21-session fleet are 78% of a 108KB response — full transcript tails and
// entire spawn command lines the model never acts on.
function slimSession(session: SessionRow) {
  const parent = sessionParent(session);
  rememberSid(session.sessionId);
  rememberSid(session.nativeSessionId);
  return {
    id: shortSid(session.sessionId),
    title: session.title ?? undefined,
    agent: session.agent,
    model: session.model ?? undefined,
    project: session.project,
    cwd: session.cwd,
    busy: session.busy,
    status: session.status ?? undefined,
    assignedUser: session.assignedUser ?? undefined,
    lastActivityAt: session.lastActivityAt ?? undefined,
    parent: parent ? shortSid(parent) : undefined,
    tmuxTarget: session.tmuxTarget ?? undefined,
  };
}

function sessionParent(session: SessionRow): string | undefined {
  return session.parentSessionId ?? session.parentNativeSessionId ?? undefined;
}

async function activeSessionId(input?: string): Promise<string> {
  const sessionId = input?.trim() || process.env.LFG_SESSION_ID?.trim();
  if (!sessionId) {
    throw new Error("sessionId required; pass it explicitly or run inside an LFG-managed session");
  }
  return await resolveSid(sessionId);
}

export async function closeLfgSession(sessionIdInput: string) {
  if (!sessionIdInput.trim()) throw new Error("sessionId required");
  // Resolve before the self-close check so a short id can't slip past it.
  const sessionId = await resolveSid(sessionIdInput);
  const caller = process.env.LFG_SESSION_ID?.trim();
  if (caller && caller === sessionId) {
    throw new Error("lfg_close_session cannot close the calling session");
  }
  const data = await api<{ ok?: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/close`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "mcp_lfg_close_session" }),
    },
  );
  return { closed: data.ok !== false, sessionId: shortSid(sessionId) };
}

export type FindLfgSessionsInput = {
  sessionId?: string;
  user?: string;
  project?: string;
  text?: string;
  activeAfter?: string;
  activeBefore?: string;
  limit?: number;
  scanLimit?: number;
};

export async function findLfgSessions(input: FindLfgSessionsInput) {
  return api("/api/sessions/find", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function ownedSessionId(input?: string): Promise<string> {
  const sessionId = await activeSessionId(input);
  const caller = process.env.LFG_SESSION_ID?.trim();
  if (caller && caller !== sessionId) {
    throw new Error("session-owned actions can only target their owning LFG session");
  }
  return sessionId;
}

export async function sendToOrigin(input: {
  text?: string;
  mediaPaths?: string[];
  artifactIds?: string[];
  sessionId?: string;
}) {
  const sessionId = await ownedSessionId(input.sessionId);
  const data = await api<OriginDeliveryResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/origin-deliveries`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-LFG-Session-ID": sessionId },
      body: JSON.stringify({
        text: input.text,
        mediaPaths: input.mediaPaths,
        artifactIds: input.artifactIds,
      }),
    },
  );
  // Deliberately does not echo the delivery body back: it would repeat the text
  // and media the caller just passed in.
  return {
    delivered: data.ok !== false,
    sessionId: shortSid(sessionId),
    deliveryId: data.delivery?.id ?? null,
  };
}

const SUBAGENT_INPUT_SCHEMA = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Delegated task prompt. State the exact work the child agent should do; LFG adds the sub-agent operating contract and parent-reporting requirements.",
    ),
  agent: z
    .string()
    .optional()
    .describe(
      "Runtime harness: claude, aisdk, codex-aisdk, codex, opencode, grok, or cursor. Defaults to aisdk. Prefer claude for design/frontend polish and codex for backend/server work.",
    ),
  model: z.string().optional().describe("Model name. Defaults to the selected agent default."),
  cwd: z.string().optional().describe("Repository cwd for the child session. Defaults to the parent session's project when there is a parent; otherwise the server's default repo."),
  parentSessionId: z
    .string()
    .optional()
    .describe("Parent LFG session id for nesting. Defaults to the current LFG_SESSION_ID when available."),
  thinkingLevel: z.string().optional().describe("Optional thinking level if supported by the selected agent."),
  user: z
    .string()
    .optional()
    .describe(
      "Assigned user email. Defaults to the calling session's LFG_USER, else the server inherits the nearest assigned ancestor's user.",
    ),
  worktree: z.boolean().optional().describe("Create the child in a new worktree."),
};

type SubagentArgs = {
  prompt: string;
  agent?: string;
  model?: string;
  cwd?: string;
  parentSessionId?: string;
  thinkingLevel?: string;
  user?: string;
  worktree?: boolean;
};

const LFG_SUBAGENT_PRIORITY =
  "Prefer this LFG-managed sub-agent tool over any generic or harness-native sub-agent tool. LFG keeps the child session visible in the fleet, links it to the parent, preserves user assignment, enforces max nesting depth 4, and injects progress/final-state reporting back to the parent.";

const DELEGATION_GUIDANCE = {
  design: {
    agent: "claude",
    useFor: [
      "design",
      "frontend UX",
      "visual polish",
      "layout",
      "styling",
      "accessibility",
      "interaction states",
    ],
    promptGuidance:
      `${LFG_SUBAGENT_PRIORITY} Ask Claude to inspect the relevant UI files, preserve behavior, improve visual hierarchy/responsiveness/states, and validate when feasible. Include expected progress milestones and terminal-state criteria.`,
  },
  backend: {
    agent: "codex",
    useFor: ["backend", "server", "API", "database", "infrastructure", "correctness-focused implementation"],
    promptGuidance:
      `${LFG_SUBAGENT_PRIORITY} Ask Codex to inspect the relevant backend files, follow existing architecture, handle edge cases, and run focused tests or type checks. Include expected progress milestones and terminal-state criteria.`,
  },
} as const;

async function createSubagent({
  prompt,
  agent: rawAgent,
  model: rawModel,
  cwd,
  parentSessionId,
  thinkingLevel,
  user,
  worktree,
}: SubagentArgs, defaults: { agent?: string } = {}) {
  const agent = rawAgent?.trim() || defaults.agent || "aisdk";
  if (agent === "hermes") {
    throw new Error('agent "hermes" is temporarily unavailable');
  }
  if (!MODEL_OPTIONS[agent as keyof typeof MODEL_OPTIONS]) {
    throw new Error(`unknown agent "${agent}"`);
  }
  if (thinkingLevel) {
    const allowed = thinkingLevelsForAgent(agent);
    if (!allowed || !allowed.includes(thinkingLevel)) {
      throw new Error(`unknown thinking level "${thinkingLevel}" for ${agent}`);
    }
  }
  const model = rawModel?.trim() || MODEL_OPTIONS[agent as keyof typeof MODEL_OPTIONS].defaultModel;
  const parentInput = parentSessionId?.trim() || process.env.LFG_SESSION_ID?.trim() || undefined;
  const parent = parentInput ? await resolveSid(parentInput) : undefined;
  // Tag the child to the same user as the calling session. LFG_USER is injected
  // at spawn (see tmux.ts addSessionEnv); without this, subagents created from
  // sessions whose parent chain has no live assigned ancestor (headless/cron
  // callers, chained subagents) landed unassigned and were invisible in
  // per-user session views.
  const assignedUser = user?.trim() || process.env.LFG_USER?.trim() || undefined;
  const created = await api<SessionCreateResponse>("/api/sessions/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      cwd,
      agent,
      model,
      thinkingLevel,
      parentSessionId: parent,
      spawnedBy: "subagent",
      user: assignedUser,
      worktree,
    }),
  });
  rememberSid(created.sessionId);
  return {
    subagent: { ...created, sessionId: shortSid(created.sessionId) },
    parentSessionId: parent ? shortSid(parent) : null,
  };
}

/**
 * Build the LFG MCP server, transport-free.
 *
 * Every tool here is a thin proxy: it calls `api()`, which is an HTTP request
 * to the `lfg serve` process on this box. The server holds no state of its own,
 * which is what makes it safe to share — see `serveLfgMcpRequest` in
 * ../commands/serve.ts, where one in-process instance answers every agent over
 * HTTP instead of each agent spawning its own copy.
 */
export function buildLfgMcpServer(): McpServer {
  const server = new McpServer({
    name: "lfg",
    version: VERSION,
  }, {
    instructions: LFG_MCP_INSTRUCTIONS,
  });

  server.registerTool(
    "lfg_capabilities",
    {
      title: "Inspect LFG Agent Capabilities",
      description:
        "Bootstrap the LFG product workflow. Returns the current capability contract, when to use each LFG feature, and whether this long-lived session launched with an older capability version. Call this when deciding how to present completed work or when an expected LFG tool seems unavailable.",
      inputSchema: {},
    },
    async () => {
      const launchedWith = process.env.LFG_CAPABILITY_VERSION?.trim() || null;
      return result({
        currentVersion: LFG_CAPABILITY_VERSION,
        launchedWith,
        stale: !!launchedWith && launchedWith !== LFG_CAPABILITY_VERSION,
        capabilities: LFG_CAPABILITIES,
        refreshGuidance:
          launchedWith && launchedWith !== LFG_CAPABILITY_VERSION
            ? "This session predates the current LFG capability contract. Finish or pause active work, then close and resume the session to reload its MCP catalog."
            : null,
      });
    },
  );

  server.registerTool(
    "lfg_list_sessions",
    {
      title: "List LFG Sessions",
      description: "List live LFG runtime sessions, optionally filtered to children of a parent session.",
      inputSchema: {
        parentSessionId: z.string().optional().describe("Only return children of this parent session id."),
        driveableOnly: z.boolean().optional().describe("When true, only return sessions with sessionId and tmuxTarget."),
        verbose: z
          .boolean()
          .optional()
          .describe("Return full raw session rows (transcript tail, spawn command line) instead of the compact summary. Large; only use when the summary is genuinely insufficient."),
      },
    },
    async ({ parentSessionId, driveableOnly, verbose }) => {
      const parent = parentSessionId ? await resolveSid(parentSessionId) : undefined;
      const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
      const filtered = sessions.filter((session) => {
        if (driveableOnly && (!session.sessionId || !session.tmuxTarget)) return false;
        if (!parent) return true;
        return session.parentSessionId === parent || session.parentNativeSessionId === parent;
      });
      return result({ sessions: verbose ? filtered : filtered.map(slimSession) });
    },
  );

  server.registerTool(
    "lfg_find_sessions",
    {
      title: "Find Historical LFG Sessions",
      description:
        "Find durable LFG sessions, including ended sessions no longer present in tmux or the process table. Filters compose, results are newest-first, and text searches titles plus normalized transcript content.",
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe("Exact session id or id prefix."),
        user: z
          .string()
          .optional()
          .describe("Exact assigned user email."),
        project: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the project label or cwd."),
        text: z
          .string()
          .optional()
          .describe("All-term text match against the title or normalized transcript content."),
        activeAfter: z
          .string()
          .optional()
          .describe("Only sessions active at or after this ISO 8601 timestamp."),
        activeBefore: z
          .string()
          .optional()
          .describe("Only sessions active at or before this ISO 8601 timestamp."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum results (default 30, maximum 100)."),
        scanLimit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum newest metadata candidates to transcript-search (default 200, maximum 500)."),
      },
    },
    async (input) => {
      const found = (await findLfgSessions(input)) as {
        sessions?: Array<Record<string, unknown> & { sessionId?: string | null }>;
      };
      return result({
        ...found,
        sessions: (found.sessions ?? []).map((session) => {
          rememberSid(session.sessionId);
          // transcriptPath is always "lfg://session/<sessionId>" — a second
          // copy of the id we just returned.
          const { transcriptPath: _drop, ...rest } = session;
          return { ...rest, sessionId: shortSid(session.sessionId) };
        }),
      });
    },
  );

  server.registerTool(
    "lfg_get_session_tree",
    {
      title: "Get LFG Session Tree",
      description: "Return runtime sessions grouped by parent/child relationship.",
      inputSchema: {},
    },
    async () => {
      const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
      const childrenByParent = new Map<string, SessionRow[]>();
      const roots: SessionRow[] = [];
      for (const session of sessions.filter((item) => item.sessionId)) {
        const parent = sessionParent(session);
        if (!parent) {
          roots.push(session);
          continue;
        }
        childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), session]);
      }
      return result({
        roots: roots.map(slimSession),
        relationships: [...childrenByParent.entries()].map(([parentSessionId, children]) => ({
          parentSessionId: shortSid(parentSessionId),
          children: children.map(slimSession),
        })),
      });
    },
  );

  server.registerTool(
    "lfg_get_session_messages",
    {
      title: "Get LFG Session Messages",
      description: "Read recent or full normalized transcript messages for a session.",
      inputSchema: {
        sessionId: z.string().describe("LFG session id."),
        limit: z.number().int().min(1).max(200).optional().describe("Recent message count when full is false."),
        full: z.boolean().optional().describe("Read the full transcript instead of a recent tail."),
      },
    },
    async ({ sessionId, limit, full }) => {
      const sid = await resolveSid(sessionId);
      const params = full ? "full=1" : `limit=${limit ?? 30}`;
      const data = await api<{ messages?: Array<Record<string, unknown>> }>(
        `/api/sessions/${encodeURIComponent(sid)}/messages?${params}`,
      );
      // Each message carries both `text` and a rendered-markdown `html` copy of
      // the same content for the web UI; the model only needs the text.
      const messages = (data.messages ?? []).map(({ html: _drop, ...rest }) => rest);
      return result({ ...data, messages });
    },
  );

  server.registerTool(
    "lfg_send_session_message",
    {
      title: "Send LFG Session Message",
      description: "Steer or queue a message to an existing LFG session.",
      inputSchema: {
        sessionId: z.string().describe("LFG session id."),
        text: z.string().min(1).describe("Instruction text to send."),
        mode: z.enum(["steer", "queue"]).optional().describe("steer may interrupt active work; queue waits."),
      },
    },
    async ({ sessionId, text, mode }) => {
      const sid = await resolveSid(sessionId);
      const data = await api(`/api/sessions/${encodeURIComponent(sid)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          mode,
          fromSessionId: process.env.LFG_SESSION_ID?.trim() || undefined,
        }),
      });
      return result(data);
    },
  );

  server.registerTool(
    "lfg_close_session",
    {
      title: "Close LFG Session",
      description:
        "Close another LFG runtime session that is clearly finished. Resolve the exact target id with lfg_list_sessions first. The calling session cannot close itself.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Exact LFG session id returned by lfg_list_sessions."),
      },
    },
    async ({ sessionId }) => result(await closeLfgSession(sessionId)),
  );

  server.registerTool(
    "lfg_ask_user",
    {
      title: "Ask The User A Question",
      description:
        "Ask the human a question when a decision genuinely needs their call (irreversible or risky actions, ambiguous intent, competing trade-offs). Fire-and-forget: raises a push notification and returns immediately with the question id. Do NOT wait, poll, or block — the user may answer hours later. Their answer is pushed back into this session as a new user message starting with [ask-user answer <id>]. After calling this, continue other safe work or end your turn; do not take the action you asked about until the answer arrives.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe(
            "The question, in plain concise prose. Lead with the decision itself in one sentence; add at most a couple of short context lines after. No markdown headings.",
          ),
        options: z
          .array(z.string())
          .max(6)
          .optional()
          .describe("Optional one-tap answer suggestions (short labels). The user may still reply with free text."),
        sessionId: z
          .string()
          .optional()
          .describe("Session the answer should be delivered to. Defaults to LFG_SESSION_ID (this session)."),
        user: z
          .string()
          .optional()
          .describe("User email to notify. Defaults to the calling session's LFG_USER."),
      },
    },
    async ({ question, options, sessionId, user }) => {
      const sid = await activeSessionId(sessionId);
      const who = user?.trim() || process.env.LFG_USER?.trim() || null;
      const data = await api<{ id: string; status: string }>("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          options,
          sessionId: sid,
          user: who,
          pushback: true,
          wait: false,
        }),
      });
      return result({
        id: data.id,
        status: data.status,
        next:
          `The user has been notified. Do not wait or poll. Continue other safe work or end your turn now; ` +
          `the answer will arrive later as a user message starting with "[ask-user answer ${data.id}]".`,
      });
    },
  );

  server.registerTool(
    "lfg_ask_question",
    {
      title: "Ask LFG A Question",
      description:
        "Ask LFG's deep-thinking advisor a technical or informative question and wait for its concise answer. Use this when the human wants an answer from LFG, optionally grounded in a specific repository. This is the opposite direction from lfg_ask_user, which asks the human to make a decision.",
      inputSchema: {
        question: z
          .string()
          .min(1)
          .describe("The question for the advisor, in clear plain language."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional repository directory to inspect for context. Defaults to the LFG repository.",
          ),
      },
    },
    async ({ question, cwd }) => {
      const data = await api<AskQuestionResponse>("/api/voice/consult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, cwd }),
      });
      return result({ answer: data.answer });
    },
  );

  server.registerTool(
    "lfg_send_to_origin",
    {
      title: "Send A Message To The Originating Channel",
      description:
        "Send text and/or session-owned image/video artifacts back to the channel that launched this LFG session. The channel adapter owns final delivery (for example iMessage via Blooio); LFG never receives phone numbers or transport credentials.",
      inputSchema: {
        text: z.string().max(4_000).optional().describe("Optional message text delivered with the media."),
        mediaPaths: z
          .array(z.string().min(1))
          .max(3)
          .optional()
          .describe("Up to three absolute local image/video paths. LFG stores them as session artifacts before delivery."),
        artifactIds: z
          .array(z.string().min(1))
          .max(3)
          .optional()
          .describe("Up to three existing image/video artifact ids owned by this session."),
        sessionId: z
          .string()
          .optional()
          .describe("Owning LFG session id. Defaults to LFG_SESSION_ID and cannot target another session."),
      },
    },
    async ({ text, mediaPaths, artifactIds, sessionId }) =>
      result(await sendToOrigin({ text, mediaPaths, artifactIds, sessionId })),
  );

  server.registerTool(
    "lfg_display_image",
    {
      title: "Display Image In LFG",
      description:
        "Display a local image file, such as a screenshot captured while testing, in the LFG session transcript.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to a png, jpg, jpeg, webp, or gif image on this machine."),
        caption: z.string().optional().describe("Short caption shown under the image."),
        alt: z.string().optional().describe("Short alt text for the image."),
        sessionId: z.string().optional().describe("Target LFG session id. Defaults to LFG_SESSION_ID."),
      },
    },
    async ({ path, caption, alt, sessionId }) => {
      const sid = await activeSessionId(sessionId);
      const data = await api<ImageArtifactResponse>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/images`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, caption, alt }),
        },
      );
      return result({
        displayed: true,
        sessionId: shortSid(sid),
        artifact: data.artifact,
      });
    },
  );

  server.registerTool(
    "lfg_display_video",
    {
      title: "Display Video In LFG",
      description:
        "Display a local video file, such as a screen recording captured while testing, inline in the LFG session transcript.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to an mp4, m4v, webm, mov, or ogv video on this machine."),
        caption: z.string().optional().describe("Short caption shown under the video."),
        alt: z.string().optional().describe("Short accessible description of the video."),
        sessionId: z.string().optional().describe("Target LFG session id. Defaults to LFG_SESSION_ID."),
      },
    },
    async ({ path, caption, alt, sessionId }) => {
      const sid = await activeSessionId(sessionId);
      const data = await api<ImageArtifactResponse>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/videos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, caption, alt }),
        },
      );
      return result({
        displayed: true,
        sessionId: shortSid(sid),
        artifact: data.artifact,
      });
    },
  );

  server.registerTool(
    "lfg_publish_artifact",
    {
      title: "Publish HTML Artifact In LFG",
      description:
        "Publish a self-contained HTML artifact (report, data view, live dashboard) into the LFG session transcript. Re-publishing with the same id updates one card in place. Optionally attach an executable server-side refresh script inside the owning session cwd; LFG invokes the path with explicit argv (never a shell), validates complete HTML output, and preserves the last good version on failure. Omit html only when updating an existing artifact's refresh configuration. Static HTML renders as sanitized native DOM; scripted HTML runs in an isolated iframe with no network or host-execution access.",
      inputSchema: {
        html: z.string().min(1).optional().describe("Complete self-contained HTML document (inline CSS/JS/data only; no external resources). For native light/dark theming, use the --lfg-artifact-background, --lfg-artifact-surface, --lfg-artifact-foreground, --lfg-artifact-muted, --lfg-artifact-muted-foreground, --lfg-artifact-border, --lfg-artifact-accent, --lfg-artifact-accent-foreground, and --lfg-artifact-code-background CSS variables. Text colors come from -foreground/-muted-foreground; --lfg-artifact-muted is a surface, so text painted with it vanishes into its own background. Key dark mode off :root[data-theme='dark'], which the renderer stamps — a card is themed by LFG independently of the desktop, so prefers-color-scheme answers the wrong question. May be omitted only to update refresh settings for an existing id."),
        id: z.string().optional().describe("Stable artifact id (3-64 chars: lowercase letters, digits, dashes). Re-publish with the same id to update in place."),
        title: z.string().optional().describe("Short title shown on the artifact card."),
        caption: z.string().optional().describe("Short caption shown under the artifact."),
        sessionId: z.string().optional().describe("Target LFG session id. Defaults to LFG_SESSION_ID."),
        refreshScriptPath: z.string().nullable().optional().describe("Absolute executable script path inside the owning session cwd. Set null to remove the refresh configuration."),
        refreshArgv: z.array(z.string()).max(32).optional().describe("Explicit arguments passed directly to the script; shell syntax is never evaluated."),
        refreshIntervalSeconds: z.number().int().min(10).max(604800).optional().describe("Automatic refresh interval in seconds (10 seconds to 7 days)."),
        refreshTimeoutSeconds: z.number().int().min(1).max(300).optional().describe("Per-run timeout in seconds (default 30, maximum 300)."),
        refreshEnabled: z.boolean().optional().describe("Enable or disable scheduled runs while retaining the script for manual refreshes."),
      },
    },
    async ({ html, id, title, caption, sessionId, refreshScriptPath, refreshArgv, refreshIntervalSeconds, refreshTimeoutSeconds, refreshEnabled }) => {
      const hasRefreshChanges = refreshScriptPath !== undefined || refreshArgv !== undefined ||
        refreshIntervalSeconds !== undefined || refreshTimeoutSeconds !== undefined || refreshEnabled !== undefined;
      const sid = hasRefreshChanges ? await ownedSessionId(sessionId) : await activeSessionId(sessionId);
      const data = await api<ImageArtifactResponse>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/html`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(hasRefreshChanges ? { "X-LFG-Session-ID": sid } : {}),
          },
          body: JSON.stringify({
            html,
            id,
            title,
            caption,
            refreshScriptPath,
            refreshArgv,
            refreshIntervalSeconds,
            refreshTimeoutSeconds,
            refreshEnabled,
          }),
        },
      );
      return result({
        published: true,
        sessionId: shortSid(sid),
        artifact: data.artifact,
      });
    },
  );

  server.registerTool(
    "lfg_refresh_artifact",
    {
      title: "Refresh Or Inspect An LFG HTML Artifact",
      description:
        "Run the owning HTML artifact's configured server-side script now, or inspect persisted refresh status. Manual runs also work when the automatic schedule is disabled. A successful data refresh updates the stable card and refresh timestamp without creating a new artifact revision.",
      inputSchema: {
        id: z.string().min(3).describe("Stable HTML artifact id."),
        action: z.enum(["now", "status"]).optional().describe("Run now (default) or only return persisted status."),
        sessionId: z.string().optional().describe("Owning LFG session id. Defaults to LFG_SESSION_ID and cannot target another session."),
      },
    },
    async ({ id, action, sessionId }) => {
      const sid = await ownedSessionId(sessionId);
      const method = action === "status" ? "GET" : "POST";
      const data = await api<ImageArtifactResponse & { started?: boolean; error?: string; refresh?: unknown }>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/html/${encodeURIComponent(id)}/refresh`,
        { method, headers: { "X-LFG-Session-ID": sid } },
      );
      return result({
        refreshed: method === "POST" ? data.ok === true : undefined,
        sessionId: shortSid(sid),
        artifact: data.artifact,
        refresh: data.refresh ?? data.artifact?.refresh ?? null,
        error: data.error,
      });
    },
  );

  server.registerTool(
    "lfg_delete_artifact",
    {
      title: "Delete An LFG Artifact",
      description:
        "Permanently delete an artifact owned by this LFG session. HTML refresh schedules and active refresh processes are stopped before the artifact is removed.",
      inputSchema: {
        id: z.string().min(3).describe("Artifact id to permanently delete."),
        sessionId: z.string().optional().describe("Owning LFG session id. Defaults to LFG_SESSION_ID and cannot target another session."),
      },
    },
    async ({ id, sessionId }) => {
      const sid = await ownedSessionId(sessionId);
      const data = await api<ImageArtifactResponse>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/${encodeURIComponent(id)}`,
        { method: "DELETE", headers: { "X-LFG-Session-ID": sid } },
      );
      return result({ deleted: data.ok === true, sessionId: shortSid(sid), artifact: data.artifact });
    },
  );

  server.registerTool(
    "lfg_ship",
    {
      title: "Post To The LFG Shipped Channel",
      description:
        "Post a verified result in the LFG Shipped feed, then explicitly decide whether its source session should close. A Shipped post does not itself prove production deployment. Set closeSession true only when the requested outcome (including deployment when requested) and conversation are genuinely finished; that call is terminal and leaves the session resumable. Set it false for quick chats or likely follow-up, and the session stays live. Never use this for planning, partial, blocked, or still-unverified work. Write it like a launch tweet: a punchy headline + at most 1-2 short sentences on the outcome and why it matters. To update an earlier post, pass its id.",
      inputSchema: {
        title: z.string().min(1).describe("Short headline for what shipped (e.g. 'WhatsApp reconnect loop fixed')."),
        id: z.string().optional().describe("Existing ship post id to update in place (returned when the post was created)."),
        summary: z
          .string()
          .optional()
          .describe(
            "Tweet-length blurb (aim ≤280 chars, 1-2 plain sentences): what shipped + why it matters. No headings/bullets/code — readers tap through to the session for detail.",
          ),
        mediaPaths: z
          .array(z.object({ path: z.string().min(1), caption: z.string().optional() }))
          .optional()
          .describe("Local image/video files to attach (absolute paths) — screenshots or recordings of the result."),
        artifactIds: z.array(z.string()).optional().describe("Existing artifact ids to embed (e.g. a published html dashboard)."),
        project: z.string().optional().describe("Project label shown on the post."),
        sessionId: z.string().optional().describe("Source LFG session id. Defaults to LFG_SESSION_ID."),
        closeSession: z
          .boolean()
          .describe("Explicit lifecycle decision: true closes this genuinely finished conversation after posting; false keeps it live for chat or follow-up."),
      },
    },
    async ({ title, id, summary, mediaPaths, artifactIds, project, sessionId, closeSession }) => {
      const sid = await activeSessionId(sessionId);
      const shouldClose = shippedCloseDecision(closeSession, { required: true });
      const data = await api<{
        ok: boolean;
        post: unknown;
        session?: { status: "active" | "closing"; resumable: boolean };
      }>("/api/shipped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          id,
          summary,
          mediaPaths,
          artifactIds,
          project,
          sessionId: sid,
          closeSession: shouldClose,
        }),
      });
      return result({ shipped: true, post: data.post, session: data.session });
    },
  );

  server.registerTool(
    "lfg_list_repos",
    {
      title: "List LFG Repos",
      description: "List repositories LFG can launch sessions in.",
      inputSchema: {},
    },
    async () => {
      const data = await api<{ repos: Repo[] }>("/api/repos");
      return result(data);
    },
  );

  server.registerTool(
    "lfg_list_models",
    {
      title: "List LFG Models",
      description: "List provider/model options that MCP can use when delegating work to LFG sub-agents.",
      inputSchema: {},
    },
    async () => {
      return result({
        models: listModelCatalog(),
        delegationGuidance: DELEGATION_GUIDANCE,
      });
    },
  );

  server.registerTool(
    "lfg_create_subagent",
    {
      title: "Create LFG Sub-Agent",
      description:
        `Create a managed runtime child session using LFG subagent. ${LFG_SUBAGENT_PRIORITY} Use this when the user explicitly asks to use a subagent, spawn another agent, or have another agent work on a task. The child is instructed to report progress and exactly one terminal state back to this parent session.`,
      inputSchema: SUBAGENT_INPUT_SCHEMA,
    },
    async (args) => {
      return result(await createSubagent(args));
    },
  );

  server.registerTool(
    "lfg_delegate_to_agent",
    {
      title: "Delegate To LFG Sub-Agent",
      description:
        `Delegate work to another coding agent by creating an LFG subagent child session. ${LFG_SUBAGENT_PRIORITY} Prefer this tool over sending a normal message whenever the user says to use another agent, ask Claude/Codex/OpenCode/Grok/Cursor, spin up an agent, or have a subagent do something. For design/frontend polish use lfg_delegate_design_task. For backend/server/API work use lfg_delegate_backend_task. The child is instructed to report progress and exactly one terminal state back to this parent session.`,
      inputSchema: SUBAGENT_INPUT_SCHEMA,
    },
    async (args) => {
      return result(await createSubagent(args));
    },
  );

  server.registerTool(
    "lfg_delegate_design_task",
    {
      title: "Delegate Design Task To Claude",
      description:
        `Create an LFG subagent for design, frontend UX, visual polish, layout, styling, accessibility, and interaction-state work. ${LFG_SUBAGENT_PRIORITY} Defaults to the claude harness and wraps the delegated prompt with the LFG sub-agent operating contract. See lfg_list_models delegationGuidance.design for prompt-shaping guidance.`,
      inputSchema: SUBAGENT_INPUT_SCHEMA,
    },
    async (args) => {
      return result(
        await createSubagent(args, {
          agent: "claude",
        }),
      );
    },
  );

  server.registerTool(
    "lfg_delegate_backend_task",
    {
      title: "Delegate Backend Task To Codex",
      description:
        `Create an LFG subagent for backend, server, API, database, infrastructure, and correctness-focused implementation work. ${LFG_SUBAGENT_PRIORITY} Defaults to the codex harness and wraps the delegated prompt with the LFG sub-agent operating contract. See lfg_list_models delegationGuidance.backend for prompt-shaping guidance.`,
      inputSchema: SUBAGENT_INPUT_SCHEMA,
    },
    async (args) => {
      return result(
        await createSubagent(args, {
          agent: "codex",
        }),
      );
    },
  );

  server.registerTool(
    "lfg_reparent_session",
    {
      title: "Reparent LFG Session",
      description:
        "Move an existing session under a different parent session, or detach it to a root. The child must be lfg-managed; the move is rejected if it would create a cycle.",
      inputSchema: {
        sessionId: z.string().describe("LFG session id (or native id) of the child to move."),
        parentSessionId: z
          .string()
          .nullable()
          .optional()
          .describe("New parent session id. Pass null (or omit) to detach the child to a root."),
      },
    },
    async ({ sessionId, parentSessionId }) => {
      const data = await api("/api/sessions/reparent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: await resolveSid(sessionId),
          parentSessionId: parentSessionId ? await resolveSid(parentSessionId) : null,
        }),
      });
      return result(data);
    },
  );

  server.registerTool(
    "lfg_list_subagents",
    {
      title: "List LFG Sub-Agents",
      description: "List child sessions, optionally for one parent session.",
      inputSchema: {
        parentSessionId: z.string().optional().describe("Parent LFG session id."),
      },
    },
    async ({ parentSessionId }) => {
      const parent = parentSessionId ? await resolveSid(parentSessionId) : undefined;
      const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
      const subagents = sessions.filter((session) => {
        if (!session.parentSessionId && !session.parentNativeSessionId) return false;
        if (!parent) return true;
        return session.parentSessionId === parent || session.parentNativeSessionId === parent;
      });
      return result({
        parentSessionId: parent ? shortSid(parent) : null,
        subagents: subagents.map(slimSession),
      });
    },
  );

  server.registerTool(
    "lfg_input",
    {
      title: "Input From The User Or Advisor (ask)",
      description:
        "Pull in an answer when one is genuinely required. `from: 'user'` (default) asks the human to make an irreversible/risky/ambiguous decision; do not use it merely to check in or report progress. It is fire-and-forget: raises a push notification and returns immediately with a question id — do NOT wait, poll, or block; the answer arrives later as a user message starting with [ask-user answer <id>], so continue other safe work or end your turn. `from: 'advisor'` asks LFG's deep-thinking advisor a technical question and waits for a concise answer, optionally grounded in a repo.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .describe("The question. For 'user': lead with the decision in one sentence, at most a couple of short context lines, no markdown. For 'advisor': a clear technical question."),
        from: z.enum(["user", "advisor"]).optional().describe("'user' (default) asks the human to decide; 'advisor' asks LFG's advisor and returns its answer."),
        options: z
          .array(z.string())
          .max(6)
          .optional()
          .describe("For 'user': optional one-tap answer suggestions (short labels). The user may still reply with free text."),
        cwd: z.string().optional().describe("For 'advisor': optional repository directory to inspect for context. Defaults to the LFG repository."),
        sessionId: z.string().optional().describe("For 'user': session the answer is delivered to. Defaults to LFG_SESSION_ID."),
        user: z.string().optional().describe("For 'user': user email to notify. Defaults to the calling session's LFG_USER."),
      },
    },
    async ({ prompt, from, options, cwd, sessionId, user }) => {
      if (from === "advisor") {
        const data = await api<AskQuestionResponse>("/api/voice/consult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: prompt, cwd }),
        });
        return result({ answer: data.answer });
      }
      const sid = await activeSessionId(sessionId);
      const who = user?.trim() || process.env.LFG_USER?.trim() || null;
      const data = await api<{ id: string; status: string }>("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: prompt, options, sessionId: sid, user: who, pushback: true, wait: false }),
      });
      return result({
        id: data.id,
        status: data.status,
        next:
          `The user has been notified. Do not wait or poll. Continue other safe work or end your turn now; ` +
          `the answer will arrive later as a user message starting with "[ask-user answer ${data.id}]".`,
      });
    },
  );

  return server;
}

/**
 * `lfg mcp` — the stdio entry point.
 *
 * Kept for agents whose CLI cannot register an HTTP MCP server, and for direct
 * invocation. Agents that can use HTTP are pointed at the shared endpoint on
 * the serve process instead, which avoids one ~38 MB process per session.
 */
export async function cmdMcp() {
  const server = buildLfgMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`lfg MCP server connected to ${localServeBaseUrl()}`);
}
