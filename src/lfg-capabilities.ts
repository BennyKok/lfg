import type { CodingAgentKind } from "./coding-agents.ts";

// Bump whenever an agent-facing LFG capability or its operating guidance
// changes. Managed sessions persist the value they launched with, which lets
// the UI identify long-lived sessions whose MCP/tool catalog predates a ship.
export const LFG_CAPABILITY_VERSION = "2026-08-04.1";

export const LFG_CAPABILITIES = [
  {
    tool: "lfg_output",
    useWhen: "Anything you send to the human — running narration, inline evidence, or a verified completion. This is the tell verb; use it continuously so a session never goes dark.",
    guidance:
      "Narrate decisions/progress with to:'thread' (the originating channel, e.g. iMessage). Show evidence inline with to:'session' (media or self-contained html). Publish verified results with to:'shipped', and explicitly choose closeSession: true only when the conversation is genuinely finished; use false for quick chats or likely follow-up. The adapter owns transport/identity — never request phone numbers or credentials.",
  },
  {
    tool: "lfg_input",
    useWhen: "You need an answer pulled in: from:'user' for a genuinely irreversible/risky/ambiguous decision, or from:'advisor' for a technical answer from LFG's advisor.",
    guidance:
      "Prefer deciding autonomously and narrating what you did — do NOT ask to check in. from:'user' is fire-and-forget: raise it once, do not poll or block; the answer arrives later as a user message. from:'advisor' returns a concise answer synchronously.",
  },
  {
    tool: "lfg_find_sessions",
    useWhen: "An ended or historical LFG session must be located after its tmux pane or process disappeared.",
    guidance: "Filter by id/prefix, user, project/cwd, title/transcript text, or last-activity range; use lfg_list_sessions for the current live fleet.",
  },
  {
    tool: "lfg_close_session",
    useWhen: "Another live session is clearly complete and should be removed from the active fleet.",
    guidance: "Resolve the exact id with lfg_list_sessions first; never close the calling session or an active, uncertain, errored, or blocked session.",
  },
  {
    tool: "lfg_create_subagent / lfg_delegate_*",
    useWhen: "The user or governing agent instructions explicitly request delegation.",
    guidance: "Prefer LFG-managed children so they stay visible, linked, and able to report progress to the parent.",
  },
] as const;

// Session ids are 36-char uuids minted by the underlying harness and are
// load-bearing on disk, so they are never re-minted. Agent-facing surfaces show
// this 8-char prefix instead; LFG's MCP layer resolves any unambiguous prefix
// back to the full id, git-short-sha style.
const SESSION_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const SHORT_SESSION_ID_LENGTH = 8;

export function shortSessionId(id: string): string {
  return SESSION_UUID.test(id) ? id.slice(0, SHORT_SESSION_ID_LENGTH) : id;
}

export const LFG_MCP_INSTRUCTIONS = [
  `This is LFG's agent capability server (capability version ${LFG_CAPABILITY_VERSION}).`,
  "Use lfg_output for every update to the human: narrate progress, show evidence, and publish verified results.",
  "Decide autonomously; use lfg_input only for a genuinely irreversible decision or to consult the advisor. Use LFG-managed delegation only when delegation is explicitly requested.",
  `Session ids are returned in short form (${SHORT_SESSION_ID_LENGTH}-char prefix, like a git short sha). Pass them back exactly as given — any unambiguous prefix resolves to the full id.`,
].join(" ");

export function lfgRuntimeContract(): string {
  return [
    `=== LFG RUNTIME CONTRACT (capability version ${LFG_CAPABILITY_VERSION}) ===`,
    "- You are an LFG-managed coding agent. Use `lfg_output` for everything sent to the human and `lfg_input` only when an answer is genuinely required.",
    "- Keep the human posted: `lfg_output` with `to:'thread'` narrates meaningful progress; `to:'session'` shows screenshot/video evidence or a self-contained HTML report.",
    "- Finish verified work with `lfg_output` `to:'shipped'`, a concise result and evidence. Set `closeSession:true` only when the task and conversation are finished, and make that your final action; otherwise use `closeSession:false`. Never ship partial or blocked work.",
    "- Shipped is not deployed. If deployment was requested, verify it before claiming it or closing the session. For LFG source changes, commit and run `scripts/land-session.sh` before shipping; shipping rejects uncommitted, unmerged, or not deployed revisions.",
    "- Decide and continue when safe. Use `lfg_input` `from:'user'` only for an irreversible, risky, or ambiguous decision; it is fire-and-forget, so do not poll. Use `from:'advisor'` for technical advice.",
    "- Never request channel identity or credentials. Use `lfg_find_sessions` for history and `lfg_list_sessions` for live sessions. Before using `lfg_close_session`, resolve the target and never close your own session.",
    "- Delegate only when explicitly requested, using `lfg_create_subagent` or `lfg_delegate_*` so children remain linked and visible.",
    `- Session ids use an ${SHORT_SESSION_ID_LENGTH}-character prefix. Pass them back exactly as shown. If an LFG tool is missing, call \`lfg_capabilities\`; report a refresh only when it returns \`stale: true\`, otherwise report the feature as unsupported.`,
    "=== END LFG RUNTIME CONTRACT ===",
  ].join("\n");
}

export function withLfgRuntimeContract(prompt: string | undefined): string | undefined {
  const text = prompt?.trim();
  if (!text) return prompt;
  if (text.includes("=== LFG RUNTIME CONTRACT")) return text;
  return `${lfgRuntimeContract()}\n\n=== USER TASK ===\n${text}`;
}

export function lfgCapabilityAccess(agent: CodingAgentKind): "mcp" | "contract-only" {
  // pi is an RPC backend with no MCP registration surface (its harness drives
  // the bundled pi CLI directly), so it never gets the LFG MCP toolset.
  return agent === "hermes" || agent === "copilot" || agent === "pi" ? "contract-only" : "mcp";
}
