import type { CodingAgentKind } from "./coding-agents.ts";

// Bump whenever an agent-facing LFG capability or its operating guidance
// changes. Managed sessions persist the value they launched with, which lets
// the UI identify long-lived sessions whose MCP/tool catalog predates a ship.
export const LFG_CAPABILITY_VERSION = "2026-07-24.1";

export const LFG_CAPABILITIES = [
  {
    tool: "lfg_output",
    useWhen: "Anything you send to the human — running narration, inline evidence, or a verified completion. This is the tell verb; use it continuously so a session never goes dark.",
    guidance:
      "Narrate decisions/progress with to:'thread' (the originating channel, e.g. iMessage). Show evidence inline with to:'session' (media or self-contained html). Post a verified completion with to:'shipped' (headline + tweet-length blurb + strongest media). Non-blocking; the adapter owns transport/identity — never request phone numbers or credentials.",
  },
  {
    tool: "lfg_input",
    useWhen: "You need an answer pulled in: from:'user' for a genuinely irreversible/risky/ambiguous decision, or from:'advisor' for a technical answer from LFG's advisor.",
    guidance:
      "Prefer deciding autonomously and narrating what you did — do NOT ask to check in. from:'user' is fire-and-forget: raise it once, do not poll or block; the answer arrives later as a user message. from:'advisor' returns a concise answer synchronously.",
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

export const LFG_MCP_INSTRUCTIONS = [
  `This is LFG's agent capability server (capability version ${LFG_CAPABILITY_VERSION}).`,
  "The agent<->human channel is two verbs: lfg_output (tell) and lfg_input (ask).",
  "Narrate your decisions and progress continuously through lfg_output so the session never goes dark; show verification media and verified completions the same way.",
  "Decide autonomously and keep moving — use lfg_input only for a genuinely irreversible decision (non-blocking) or to consult the advisor. Use lfg_capabilities to detect a stale long-lived session, and LFG-managed delegation when delegation is explicitly requested.",
].join(" ");

export function lfgRuntimeContract(): string {
  return [
    `=== LFG RUNTIME CONTRACT (capability version ${LFG_CAPABILITY_VERSION}) ===`,
    "- You are running as an LFG-managed coding agent. LFG features are part of the product workflow, not optional implementation trivia.",
    "- The whole agent<->human channel is TWO verbs: `lfg_output` (tell the human) and `lfg_input` (ask the human). Reach for these first.",
    "- NARRATE as you work: keep the human posted through `lfg_output` with `to:'thread'` at each meaningful decision or step. Do not go dark — a silent session is a failed session. This is a duty, not an option.",
    "- Show evidence with `lfg_output` `to:'session'` — attach screenshots/recordings as `media`, or publish a self-contained report/dashboard as `html` (re-use `id` to update in place).",
    "- When material user-visible work is complete and verified, use `lfg_output` `to:'shipped'` with a concise headline + tweet-length blurb and the strongest media. Do not ship diagnosis, planning, partial, invisible, or trivial work.",
    "- DECIDE, don't park: make the reasonable call yourself and narrate it. Use `lfg_input` (`from:'user'`) ONLY for a genuinely irreversible, risky, or ambiguous decision — never to check in or report progress. It is fire-and-forget: do not poll or block; the answer arrives later. Use `from:'advisor'` to consult LFG's advisor.",
    "- The channel adapter owns transport identity and credentials; never request phone numbers or channel credentials.",
    "- When the user or governing instructions explicitly request delegation, prefer `lfg_create_subagent` or `lfg_delegate_*` so children remain visible and linked in LFG.",
    "- Use `lfg_close_session` only after resolving another session's exact id with `lfg_list_sessions`; never close your own session.",
    "- If an exact LFG tool is unavailable, call `lfg_capabilities`. Report that the session needs a capability refresh only when it returns `stale: true`; otherwise report that the capability is unsupported. Do not reverse-engineer or call LFG's private HTTP endpoints as a substitute.",
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
