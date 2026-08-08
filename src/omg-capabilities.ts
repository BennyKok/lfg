import type { CodingAgentKind } from "./coding-agents.ts";

// Bump whenever an agent-facing OMG capability or its operating guidance
// changes. Managed sessions persist the value they launched with, which lets
// the UI identify long-lived sessions whose MCP/tool catalog predates a ship.
export const OMG_CAPABILITY_VERSION = "2026-08-08.1";

export const OMG_CAPABILITIES = [
  {
    tool: "omg_ship",
    useWhen: "The assigned task is finished and its result has been verified.",
    guidance:
      "This is how finished work reaches the human — a session that never ships is invisible. Post a headline, a tweet-length result and the strongest evidence, then decide closeSession explicitly. Never ship planning, partial, or blocked work.",
  },
  {
    tool: "omg_display_image / omg_display_video",
    useWhen: "A local screenshot or recording would provide useful visual evidence in the OMG transcript.",
    guidance: "Use these only for image/video evidence. Communicate with the human through normal assistant messages.",
  },
  {
    tool: "omg_input",
    useWhen: "A genuinely irreversible, risky, or ambiguous decision requires the human's answer.",
    guidance:
      "Prefer deciding autonomously — do NOT ask merely to check in. This is fire-and-forget: raise it once, do not poll or block; the answer arrives later as a user message.",
  },
  {
    tool: "omg_find_sessions",
    useWhen: "An ended or historical OMG session must be located after its tmux pane or process disappeared.",
    guidance: "Filter by id/prefix, user, project/cwd, title/transcript text, or last-activity range; use omg_list_sessions for the current live fleet.",
  },
  {
    tool: "omg_close_session",
    useWhen: "Another live session is clearly complete and should be removed from the active fleet.",
    guidance: "Resolve the exact id with omg_list_sessions first; never close the calling session or an active, uncertain, errored, or blocked session.",
  },
  {
    tool: "omg_create_subagent / omg_delegate_*",
    useWhen: "The user or governing agent instructions explicitly request delegation.",
    guidance: "Prefer OMG-managed children so they stay visible, linked, and able to report progress to the parent.",
  },
  {
    tool: "omg_list_auto_agents / omg_save_auto_agent / omg_run_auto_agent",
    useWhen: "Recurring scheduled work should be created, inspected, edited, or triggered on demand.",
    guidance:
      "Auto agents are the box's cron-shaped fleet: a prompt plus a schedule that reports back as findings. Use omg_compose_auto_agent to turn a freeform ask into a draft, then omg_save_auto_agent to persist it, and omg_list_findings to read what they reported.",
  },
] as const;

// Session ids are 36-char uuids minted by the underlying harness and are
// load-bearing on disk, so they are never re-minted. Agent-facing surfaces show
// this 8-char prefix instead; OMG's MCP layer resolves any unambiguous prefix
// back to the full id, git-short-sha style.
const SESSION_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const SHORT_SESSION_ID_LENGTH = 8;

export function shortSessionId(id: string): string {
  return SESSION_UUID.test(id) ? id.slice(0, SHORT_SESSION_ID_LENGTH) : id;
}

export const OMG_MCP_INSTRUCTIONS = [
  `This is OMG's agent capability server (capability version ${OMG_CAPABILITY_VERSION}).`,
  "Communicate with the human through normal assistant messages. Use omg_display_image or omg_display_video when local visual evidence is useful.",
  "Publish every verified result with omg_ship, choosing closeSession explicitly; work that is never shipped never reaches the human.",
  "Decide autonomously; use omg_input only for a genuinely irreversible, risky, or ambiguous decision. Use OMG-managed delegation only when delegation is explicitly requested.",
  "Recurring scheduled work belongs to the auto agent tools (omg_list_auto_agents, omg_compose_auto_agent, omg_save_auto_agent, omg_run_auto_agent, omg_list_findings).",
  `Session ids are returned in short form (${SHORT_SESSION_ID_LENGTH}-char prefix, like a git short sha). Pass them back exactly as given — any unambiguous prefix resolves to the full id.`,
].join(" ");

export function omgRuntimeContract(): string {
  return [
    `=== OMG RUNTIME CONTRACT (capability version ${OMG_CAPABILITY_VERSION}) ===`,
    "- You are an OMG-managed coding agent. Communicate with the human through normal assistant messages; OMG tool calls do not replace those replies.",
    "- Use `omg_display_image` or `omg_display_video` when a local screenshot or recording provides useful evidence in the OMG transcript.",
    "- Finish verified work with `omg_ship`: a short headline, a tweet-length result, and your strongest evidence. Set `closeSession:true` only when the task and conversation are genuinely finished, and make that call your final action; otherwise `closeSession:false` and keep working. Never ship planning, partial, or blocked work.",
    "- Shipped is not deployed. If deployment was requested, verify it before claiming it or closing the session. For OMG source changes, commit and run `scripts/land-session.sh` before shipping; shipping is rejected while changes are uncommitted, unmerged, or not deployed at the current main revision.",
    "- Decide and continue when safe. Use `omg_input` only for an irreversible, risky, or ambiguous decision; it is fire-and-forget, so do not poll.",
    "- Never request channel identity or credentials. Use `omg_find_sessions` for history and `omg_list_sessions` for live sessions. Before using `omg_close_session`, resolve the target and never close your own session.",
    "- Delegate only when explicitly requested, using `omg_create_subagent` or `omg_delegate_*` so children remain linked and visible.",
    "- Recurring/scheduled work is an auto agent, not a long-lived session: compose it with `omg_compose_auto_agent`, save it with `omg_save_auto_agent`, and read results with `omg_list_findings`.",
    `- Session ids use an ${SHORT_SESSION_ID_LENGTH}-character prefix. Pass them back exactly as shown. If an OMG tool is missing, call \`omg_capabilities\`; report a refresh only when it returns \`stale: true\`, otherwise report the feature as unsupported.`,
    "=== END OMG RUNTIME CONTRACT ===",
  ].join("\n");
}

// The envelope was branded "LFG" before the rename. Both spellings have to be
// recognised forever: transcripts, resume caches and argv of every session
// launched before the rebrand still carry the old header, and those sessions
// outlive the deploy that renamed them.
const CONTRACT_HEADERS = ["=== OMG RUNTIME CONTRACT", "=== LFG RUNTIME CONTRACT"] as const;
const CONTRACT_ENDS = ["=== END OMG RUNTIME CONTRACT ===", "=== END LFG RUNTIME CONTRACT ==="] as const;
const USER_TASK = "=== USER TASK ===";

/** Earliest occurrence of any known contract marker, or -1. */
function firstIndexOf(text: string, needles: readonly string[], from = 0): { at: number; needle: string } {
  let best = { at: -1, needle: "" };
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    if (at < 0) continue;
    if (best.at < 0 || at < best.at) best = { at, needle };
  }
  return best;
}

export function hasOmgRuntimeContract(text: string): boolean {
  return firstIndexOf(text, CONTRACT_HEADERS).at >= 0;
}

export function withOmgRuntimeContract(prompt: string | undefined): string | undefined {
  const text = prompt?.trim();
  if (!text) return prompt;
  // Already wrapped — including by a pre-rename LFG envelope, which must not be
  // double-wrapped just because the branding changed.
  if (hasOmgRuntimeContract(text)) return text;
  return `${omgRuntimeContract()}\n\n${USER_TASK}\n${text}`;
}

/**
 * Inverse of withOmgRuntimeContract, for display surfaces only.
 *
 * The envelope stays in the transcript and is still what the agent reads; this
 * recovers the human's actual prompt so cards, titles and previews aren't all
 * labelled with OMG's own boilerplate. Anything between the contract and the
 * task marker (MCP instructions, skill listings) is preamble too, so the task
 * marker wins when present. Returns the input unchanged when no envelope is
 * found, and never returns empty — a contract with no task behind it keeps the
 * original text rather than blanking the card.
 */
export function stripOmgRuntimeContract(text: string): string {
  const header = firstIndexOf(text, CONTRACT_HEADERS);
  if (header.at < 0) return text;
  const end = firstIndexOf(text, CONTRACT_ENDS, header.at + header.needle.length);
  if (end.at < 0) return text;
  const after = text.slice(end.at + end.needle.length);
  const taskAt = after.indexOf(USER_TASK);
  const body = taskAt < 0 ? after : after.slice(taskAt + USER_TASK.length);
  return `${text.slice(0, header.at)}${body}`.trim() || text;
}

/**
 * Card title for a session launched with `prompt`.
 *
 * Harness backends recover their initial prompt from argv, where it still
 * carries the launch envelope, so they must strip it before titling — an
 * unstripped title reads "=== OMG RUNTIME CONTRACT (capability ve…" on every
 * managed session instead of the human's ask.
 */
export function sessionTitleFromPrompt(prompt: string | null | undefined, max = 72): string | null {
  if (!prompt) return null;
  const text = stripOmgRuntimeContract(prompt).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function omgCapabilityAccess(agent: CodingAgentKind): "mcp" | "contract-only" {
  // pi is an RPC backend with no MCP registration surface (its harness drives
  // the bundled pi CLI directly), so it never gets the OMG MCP toolset.
  return agent === "hermes" || agent === "copilot" || agent === "pi" ? "contract-only" : "mcp";
}
