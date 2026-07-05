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

const VERSION = "0.1.1";

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
      description: "List configured provider/model options for runtime sessions.",
      inputSchema: {},
    },
    async () => {
      return result({ models: listModelCatalog().filter((model) => model.session) });
    },
  );

  server.registerTool(
    "lfg_create_subagent",
    {
      title: "Create LFG Sub-Agent",
      description: "Create a managed runtime child session under a parent session.",
      inputSchema: {
        prompt: z.string().min(1).describe("Delegated task prompt."),
        agent: z.string().optional().describe("Runtime harness, such as aisdk, codex-aisdk, opencode, grok, or hermes."),
        model: z.string().optional().describe("Model name. Defaults to the selected agent default."),
        cwd: z.string().optional().describe("Repository cwd for the child session."),
        parentSessionId: z.string().optional().describe("Parent LFG session id for nesting."),
        thinkingLevel: z.string().optional().describe("Optional thinking level if supported by the agent."),
        user: z.string().optional().describe("Assigned user email."),
        worktree: z.boolean().optional().describe("Create the child in a new worktree."),
      },
    },
    async ({ prompt, agent: rawAgent, model: rawModel, cwd, parentSessionId, thinkingLevel, user, worktree }) => {
      const agent = rawAgent?.trim() || "aisdk";
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
      const created = await api<SessionCreateResponse>("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          cwd,
          agent,
          model,
          thinkingLevel,
          parentSessionId,
          spawnedBy: "subagent",
          user,
          worktree,
        }),
      });
      return result({ subagent: created, parentSessionId: parentSessionId ?? null });
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
