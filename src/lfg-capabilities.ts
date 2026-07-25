import type { CodingAgentKind } from "./coding-agents.ts";

// Bump whenever an agent-facing LFG capability or its operating guidance
// changes. Managed sessions persist the value they launched with, which lets
// the UI identify long-lived sessions whose MCP/tool catalog predates a ship.
export const LFG_CAPABILITY_VERSION = "2026-07-23.1";

export const LFG_CAPABILITIES = [
  {
    tool: "lfg_send_to_origin",
    useWhen: "The agent should intentionally deliver text or visual evidence back to the channel that launched this session.",
    guidance: "Send only user-facing results. The origin adapter owns transport and identity; never request phone numbers or channel credentials.",
  },
  {
    tool: "lfg_close_session",
    useWhen: "Another live session is clearly complete and should be removed from the active fleet.",
    guidance: "Resolve the exact id with lfg_list_sessions first; never close the calling session or an active, uncertain, errored, or blocked session.",
  },
  {
    tool: "lfg_ship",
    useWhen: "Material user-visible work is complete and verified.",
    guidance: "Post a concise showcase with the strongest verification media; skip diagnosis, planning, partial, invisible, or trivial work.",
  },
  {
    tool: "lfg_display_image / lfg_display_video",
    useWhen: "Visual or interaction work has screenshot or recording evidence.",
    guidance: "Display the best evidence in the session and reuse it in lfg_ship when the work is worth showcasing.",
  },
  {
    tool: "lfg_publish_artifact",
    useWhen: "A report, data view, or live dashboard is materially clearer as interactive HTML than prose.",
    guidance: "Use a stable id when the artifact should update in place.",
  },
  {
    tool: "lfg_ask_user",
    useWhen: "A risky, irreversible, or genuinely ambiguous decision needs the human.",
    guidance: "Ask once, do not poll, and continue other safe work while the answer is pushed back later.",
  },
  {
    tool: "lfg_create_subagent / lfg_delegate_*",
    useWhen: "The user or governing agent instructions explicitly request delegation.",
    guidance: "Prefer LFG-managed children so they stay visible, linked, and able to report progress to the parent.",
  },
] as const;

export const LFG_MCP_INSTRUCTIONS = [
  `This is LFG's agent capability server (capability version ${LFG_CAPABILITY_VERSION}).`,
  "Use lfg_capabilities to inspect the current feature contract and detect a stale long-lived session.",
  "Use LFG presentation tools for meaningful outputs: display visual verification, publish rich HTML when it beats prose, and post verified user-visible completions to Shipped.",
  "Use lfg_ask_user only for decisions that genuinely require the human. Use LFG-managed delegation when delegation is explicitly requested.",
].join(" ");

export function lfgRuntimeContract(): string {
  return [
    `=== LFG RUNTIME CONTRACT (capability version ${LFG_CAPABILITY_VERSION}) ===`,
    "- You are running as an LFG-managed coding agent. LFG features are part of the product workflow, not optional implementation trivia.",
    "- After visual or interaction work, capture verification media and show the best evidence with `lfg_display_image` or `lfg_display_video`.",
    "- Use `lfg_send_to_origin` when the user wants a result intentionally delivered back to the channel that launched this session. The origin adapter owns transport identity and credentials.",
    "- When a report, data view, or live dashboard is materially clearer as interactive HTML than prose, publish it with `lfg_publish_artifact`; use a stable id for updates.",
    "- When material user-visible work is complete and verified, call `lfg_ship` with a concise showcase and the strongest media. Do not ship diagnosis, planning, partial, invisible, or trivial work.",
    "- Use `lfg_ask_user` only for a risky, irreversible, or genuinely ambiguous decision. It is fire-and-forget: do not poll or block waiting for the answer.",
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
