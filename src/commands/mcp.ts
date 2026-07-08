import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  MODEL_OPTIONS,
  listModelCatalog,
  thinkingLevelsForAgent,
} from "../agent-catalog.ts";

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
};
type ImageArtifactResponse = {
  ok?: boolean;
  artifact?: {
    id: string;
    url: string;
    name: string;
    caption?: string;
    alt?: string;
  };
  message?: {
    url?: string;
    text?: string;
    name?: string;
  };
};

const VERSION = "0.1.19";

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

const SUBAGENT_INPUT_SCHEMA = {
  prompt: z.string().min(1).describe("Delegated task prompt. State the exact work the child agent should do."),
  agent: z
    .string()
    .optional()
    .describe(
      "Runtime harness: claude, aisdk, codex-aisdk, codex, opencode, grok, or hermes. Defaults to aisdk. Prefer claude for design/frontend polish and codex for backend/server work.",
    ),
  model: z.string().optional().describe("Model name. Defaults to the selected agent default."),
  cwd: z.string().optional().describe("Repository cwd for the child session. Defaults to the server's default repo."),
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
      "Ask Claude to inspect the relevant UI files, preserve behavior, improve visual hierarchy/responsiveness/states, and validate when feasible.",
  },
  backend: {
    agent: "codex",
    useFor: ["backend", "server", "API", "database", "infrastructure", "correctness-focused implementation"],
    promptGuidance:
      "Ask Codex to inspect the relevant backend files, follow existing architecture, handle edge cases, and run focused tests or type checks.",
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
  });

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
        body: JSON.stringify({ text, mode }),
      });
      return result(data);
    },
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
        markdown: data.message?.url
          ? `![${caption || alt || data.message.name || "image"}](${data.message.url})`
          : undefined,
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
        "Create a managed runtime child session using LFG subagent. Use this when the user explicitly asks to use a subagent, spawn another agent, or have another agent work on a task.",
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
        "Delegate work to another coding agent by creating an LFG subagent child session. Prefer this tool over sending a normal message whenever the user says to use another agent, ask Claude/Codex/OpenCode/Grok/Hermes, spin up an agent, or have a subagent do something. For design/frontend polish use lfg_delegate_design_task. For backend/server/API work use lfg_delegate_backend_task.",
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
        "Create an LFG subagent for design, frontend UX, visual polish, layout, styling, accessibility, and interaction-state work. Defaults to the claude harness and sends the delegated prompt unchanged. See lfg_list_models delegationGuidance.design for prompt-shaping guidance.",
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
        "Create an LFG subagent for backend, server, API, database, infrastructure, and correctness-focused implementation work. Defaults to the codex harness and sends the delegated prompt unchanged. See lfg_list_models delegationGuidance.backend for prompt-shaping guidance.",
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
