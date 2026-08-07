import type { CodingAgentKind } from "./coding-agents.ts";

// Bump whenever an agent-facing LFG capability or its operating guidance
// changes. Managed sessions persist the value they launched with, which lets
// the UI identify long-lived sessions whose MCP/tool catalog predates a ship.
export const LFG_CAPABILITY_VERSION = "2026-08-07.1";

export const LFG_CAPABILITIES = [
  {
    tool: "lfg_ship",
    useWhen: "The assigned task is finished and its result has been verified.",
    guidance:
      "This is how finished work reaches the human — a session that never ships is invisible. Post a headline, a tweet-length result and the strongest evidence, then decide closeSession explicitly. Never ship planning, partial, or blocked work.",
  },
  {
    tool: "lfg_display_image / lfg_display_video",
    useWhen: "A local screenshot or recording would provide useful visual evidence in the LFG transcript.",
    guidance: "Use these only for image/video evidence. Communicate with the human through normal assistant messages.",
  },
  {
    tool: "lfg_input",
    useWhen: "A genuinely irreversible, risky, or ambiguous decision requires the human's answer.",
    guidance:
      "Prefer deciding autonomously — do NOT ask merely to check in. This is fire-and-forget: raise it once, do not poll or block; the answer arrives later as a user message.",
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
  "Communicate with the human through normal assistant messages. Use lfg_display_image or lfg_display_video when local visual evidence is useful.",
  "Publish every verified result with lfg_ship, choosing closeSession explicitly; work that is never shipped never reaches the human.",
  "Decide autonomously; use lfg_input only for a genuinely irreversible, risky, or ambiguous decision. Use LFG-managed delegation only when delegation is explicitly requested.",
  `Session ids are returned in short form (${SHORT_SESSION_ID_LENGTH}-char prefix, like a git short sha). Pass them back exactly as given — any unambiguous prefix resolves to the full id.`,
].join(" ");

export function lfgRuntimeContract(): string {
  return [
    `=== LFG RUNTIME CONTRACT (capability version ${LFG_CAPABILITY_VERSION}) ===`,
    "- You are an LFG-managed coding agent. Communicate with the human through normal assistant messages; LFG tool calls do not replace those replies.",
    "- Use `lfg_display_image` or `lfg_display_video` when a local screenshot or recording provides useful evidence in the LFG transcript.",
    "- Finish verified work with `lfg_ship`: a short headline, a tweet-length result, and your strongest evidence. Set `closeSession:true` only when the task and conversation are genuinely finished, and make that call your final action; otherwise `closeSession:false` and keep working. Never ship planning, partial, or blocked work.",
    "- Shipped is not deployed. If deployment was requested, verify it before claiming it or closing the session. For LFG source changes, commit and run `scripts/land-session.sh` before shipping; shipping is rejected while changes are uncommitted, unmerged, or not deployed at the current main revision.",
    "- Decide and continue when safe. Use `lfg_input` only for an irreversible, risky, or ambiguous decision; it is fire-and-forget, so do not poll.",
    "- Never request channel identity or credentials. Use `lfg_find_sessions` for history and `lfg_list_sessions` for live sessions. Before using `lfg_close_session`, resolve the target and never close your own session.",
    "- Delegate only when explicitly requested, using `lfg_create_subagent` or `lfg_delegate_*` so children remain linked and visible.",
    `- Session ids use an ${SHORT_SESSION_ID_LENGTH}-character prefix. Pass them back exactly as shown. If an LFG tool is missing, call \`lfg_capabilities\`; report a refresh only when it returns \`stale: true\`, otherwise report the feature as unsupported.`,
    "=== END LFG RUNTIME CONTRACT ===",
  ].join("\n");
}

const CONTRACT_HEADER = "=== LFG RUNTIME CONTRACT";
const CONTRACT_END = "=== END LFG RUNTIME CONTRACT ===";
const USER_TASK = "=== USER TASK ===";

export function withLfgRuntimeContract(prompt: string | undefined): string | undefined {
  const text = prompt?.trim();
  if (!text) return prompt;
  if (text.includes(CONTRACT_HEADER)) return text;
  return `${lfgRuntimeContract()}\n\n${USER_TASK}\n${text}`;
}

/**
 * Inverse of withLfgRuntimeContract, for display surfaces only.
 *
 * The envelope stays in the transcript and is still what the agent reads; this
 * recovers the human's actual prompt so cards, titles and previews aren't all
 * labelled with LFG's own boilerplate. Anything between the contract and the
 * task marker (MCP instructions, skill listings) is preamble too, so the task
 * marker wins when present. Returns the input unchanged when no envelope is
 * found, and never returns empty — a contract with no task behind it keeps the
 * original text rather than blanking the card.
 */
export function stripLfgRuntimeContract(text: string): string {
  const start = text.indexOf(CONTRACT_HEADER);
  if (start < 0) return text;
  const end = text.indexOf(CONTRACT_END, start + CONTRACT_HEADER.length);
  if (end < 0) return text;
  const after = text.slice(end + CONTRACT_END.length);
  const taskAt = after.indexOf(USER_TASK);
  const body = taskAt < 0 ? after : after.slice(taskAt + USER_TASK.length);
  return `${text.slice(0, start)}${body}`.trim() || text;
}

/**
 * Card title for a session launched with `prompt`.
 *
 * Harness backends recover their initial prompt from argv, where it still
 * carries the launch envelope, so they must strip it before titling — an
 * unstripped title reads "=== LFG RUNTIME CONTRACT (capability ve…" on every
 * managed session instead of the human's ask.
 */
export function sessionTitleFromPrompt(prompt: string | null | undefined, max = 72): string | null {
  if (!prompt) return null;
  const text = stripLfgRuntimeContract(prompt).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function lfgCapabilityAccess(agent: CodingAgentKind): "mcp" | "contract-only" {
  // pi is an RPC backend with no MCP registration surface (its harness drives
  // the bundled pi CLI directly), so it never gets the LFG MCP toolset.
  return agent === "hermes" || agent === "copilot" || agent === "pi" ? "contract-only" : "mcp";
}
