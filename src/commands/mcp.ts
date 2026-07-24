import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  MODEL_OPTIONS,
  listModelCatalog,
  thinkingLevelsForAgent,
} from "../agent-catalog.ts";
import {
  LFG_CAPABILITIES,
  LFG_CAPABILITY_VERSION,
  LFG_MCP_INSTRUCTIONS,
} from "../lfg-capabilities.ts";

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

function baseUrl(): string {
  if (process.env.LFG_BASE) return process.env.LFG_BASE.replace(/\/$/, "");
  const host = process.env.LFG_HOST || "127.0.0.1";
  const port = process.env.LFG_PORT || process.env.PORT || "8766";
  return `http://${host}:${port}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data as T;
}

function result(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function sessionParent(session: SessionRow): string | undefined {
  return session.parentSessionId ?? session.parentNativeSessionId ?? undefined;
}

function activeSessionId(input?: string): string {
  const sessionId = input?.trim() || process.env.LFG_SESSION_ID?.trim();
  if (!sessionId) {
    throw new Error("sessionId required; pass it explicitly or run inside an LFG-managed session");
  }
  return sessionId;
}

export async function closeLfgSession(sessionIdInput: string) {
  const sessionId = sessionIdInput.trim();
  if (!sessionId) throw new Error("sessionId required");
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
  return { closed: data.ok !== false, sessionId };
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

function ownedSessionId(input?: string): string {
  const sessionId = activeSessionId(input);
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
  const sessionId = ownedSessionId(input.sessionId);
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
  return { delivered: data.ok !== false, sessionId, delivery: data.delivery };
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
  const parent = parentSessionId?.trim() || process.env.LFG_SESSION_ID?.trim() || undefined;
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
  return { subagent: created, parentSessionId: parent ?? null };
}

export async function cmdMcp() {
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
      },
    },
    async ({ parentSessionId, driveableOnly }) => {
      const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
      const filtered = sessions.filter((session) => {
        if (driveableOnly && (!session.sessionId || !session.tmuxTarget)) return false;
        if (!parentSessionId) return true;
        return session.parentSessionId === parentSessionId || session.parentNativeSessionId === parentSessionId;
      });
      return result({ sessions: filtered });
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
    async (input) => result(await findLfgSessions(input)),
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
        roots,
        relationships: [...childrenByParent.entries()].map(([parentSessionId, children]) => ({
          parentSessionId,
          children,
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
      const params = full ? "full=1" : `limit=${limit ?? 30}`;
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${params}`);
      return result(data);
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
      const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
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
      const sid = activeSessionId(sessionId);
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
      const sid = activeSessionId(sessionId);
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
        sessionId: sid,
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
      const sid = activeSessionId(sessionId);
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
        sessionId: sid,
        artifact: data.artifact,
      });
    },
  );

  server.registerTool(
    "lfg_publish_artifact",
    {
      title: "Publish HTML Artifact In LFG",
      description:
        "Publish a self-contained HTML artifact (report, data view, live dashboard) into the LFG session transcript. Re-publishing with the same id updates one card in place. Optionally attach an executable server-side refresh script inside the owning session cwd; LFG invokes the path with explicit argv (never a shell), validates complete HTML output, and preserves the last good version on failure. Omit html only when updating an existing artifact's refresh configuration. The HTML iframe has no network or host-execution access.",
      inputSchema: {
        html: z.string().min(1).optional().describe("Complete self-contained HTML document (inline CSS/JS/data only; no external resources). May be omitted only to update refresh settings for an existing id."),
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
      const sid = hasRefreshChanges ? ownedSessionId(sessionId) : activeSessionId(sessionId);
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
        sessionId: sid,
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
      const sid = ownedSessionId(sessionId);
      const method = action === "status" ? "GET" : "POST";
      const data = await api<ImageArtifactResponse & { started?: boolean; error?: string; refresh?: unknown }>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/html/${encodeURIComponent(id)}/refresh`,
        { method, headers: { "X-LFG-Session-ID": sid } },
      );
      return result({
        refreshed: method === "POST" ? data.ok === true : undefined,
        sessionId: sid,
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
      const sid = ownedSessionId(sessionId);
      const data = await api<ImageArtifactResponse>(
        `/api/sessions/${encodeURIComponent(sid)}/artifacts/${encodeURIComponent(id)}`,
        { method: "DELETE", headers: { "X-LFG-Session-ID": sid } },
      );
      return result({ deleted: data.ok === true, sessionId: sid, artifact: data.artifact });
    },
  );

  server.registerTool(
    "lfg_ship",
    {
      title: "Post To The LFG Shipped Channel",
      description:
        "Showcase finished work in the LFG Shipped channel — a feed of what agents completed, with visuals. Call this when you finish something worth showing. Write it like a launch tweet: a punchy headline + at most 1-2 short sentences on WHAT shipped and why it matters. NOT a changelog — no bullet lists, no headings, no implementation detail, no file names; the session transcript already holds all of that. Attach the screenshots/recordings you captured while verifying (mediaPaths), or embed an existing artifact like a live dashboard (artifactIds). Images are optimized automatically before storage. To UPDATE an earlier post (e.g. after follow-up feedback), pass its id — the post revises in place and the feed shows the new version.",
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
      },
    },
    async ({ title, id, summary, mediaPaths, artifactIds, project, sessionId }) => {
      const sid = activeSessionId(sessionId);
      const data = await api<{ ok: boolean; post: unknown }>("/api/shipped", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id, summary, mediaPaths, artifactIds, project, sessionId: sid }),
      });
      return result({ shipped: true, post: data.post });
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
        body: JSON.stringify({ sessionId, parentSessionId: parentSessionId ?? null }),
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
      const { sessions } = await api<{ sessions: SessionRow[] }>("/api/sessions");
      const subagents = sessions.filter((session) => {
        if (!session.parentSessionId && !session.parentNativeSessionId) return false;
        if (!parentSessionId) return true;
        return session.parentSessionId === parentSessionId || session.parentNativeSessionId === parentSessionId;
      });
      return result({ parentSessionId: parentSessionId ?? null, subagents });
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`lfg MCP server connected to ${baseUrl()}`);
}
