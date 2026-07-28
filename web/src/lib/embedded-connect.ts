// Embedded first-run: which coding agent (if any) a framed LFG can actually
// run work with, and what to offer when the answer is "none".
//
// Standalone LFG walks a fresh box through OnboardingFlow (profile → agents →
// repo → session). Embed mode deliberately hides onboarding *and* settings —
// the host owns account UX — which left a fresh omg Computer with no way to
// connect a coding agent at all. This module is the shared, testable decision
// layer for the embed-only gate that fills that hole; the auth itself still
// runs through the existing /api/coding-agents/:kind/auth flow.

/** The subset of CodingAgentInfo this module needs (kept structural so both
 *  App.tsx's local type and the server's export satisfy it). */
export type ConnectAgentInfo = {
  key: string;
  label: string;
  status: {
    configured: boolean;
    canAutoSetup: boolean;
    checks: { label: string; ok: boolean; detail?: string }[];
  };
};

export type ConnectOption = {
  /** Auth provider the CLI login belongs to. */
  provider: "claude" | "codex";
  /** Coding agent kind to drive install/login with. */
  kind: string;
  /** Product name shown on the card. */
  label: string;
  /** CLI binary is present on this box. */
  installed: boolean;
  /** Binary present *and* authenticated. */
  configured: boolean;
  /** Server says the missing CLI can be installed from the UI. */
  canAutoSetup: boolean;
};

/** The two providers the embedded gate offers, in display order. Both reuse
 *  the browser-login path (`claude auth login --claudeai` / `codex login
 *  --device-auth`); every other agent kind is terminal-only, which a framed
 *  surface cannot show. */
const GATE_PROVIDERS: {
  provider: "claude" | "codex";
  /** Kind the gate drives install/login with. */
  kind: string;
  label: string;
  /** Every kind that shares this provider's credentials — a login through
   *  either CLI configures its ai-sdk sibling too. */
  kinds: string[];
}[] = [
  { provider: "claude", kind: "claude", label: "Claude Code", kinds: ["claude", "aisdk"] },
  { provider: "codex", kind: "codex", label: "Codex", kinds: ["codex", "codex-aisdk"] },
];

const GATE_PROVIDER_KINDS = new Set(GATE_PROVIDERS.flatMap((entry) => entry.kinds));

/** statusFor() emits exactly one binary check per agent, always labelled
 *  "<Product> CLI" ("Claude CLI", "Codex CLI"). Auth checks are labelled
 *  "<Product> auth", so the CLI suffix is what separates the two. */
function binaryInstalled(agent: ConnectAgentInfo): boolean {
  const binary = agent.status.checks.find((check) => check.label.endsWith(" CLI"));
  return binary ? binary.ok : agent.status.configured;
}

/**
 * True when Claude or Codex is connected — the only two providers this gate
 * can actually connect from a frame.
 *
 * Deliberately NOT "any configured agent": an agent-lfg image ships pi bundled
 * (and can carry OpenCode/Copilot creds from the image), so `agents.some(
 * configured)` would report a fresh Computer as ready and skip the connect
 * prompt the user still needs. Someone genuinely working on one of those
 * providers takes the gate's skip link instead.
 */
export function hasConnectedGateProvider(agents: ConnectAgentInfo[]): boolean {
  return agents.some((agent) => GATE_PROVIDER_KINDS.has(agent.key) && agent.status.configured);
}

/**
 * Show the embedded connect gate only when we positively know the box has
 * neither provider connected. An empty roster means the bootstrap payload
 * never arrived (or failed) — gating on that would trap the user behind a card
 * we cannot resolve, so it stays closed.
 */
export function shouldShowEmbeddedConnectGate(input: {
  embedded: boolean;
  agents: ConnectAgentInfo[];
  dismissed?: boolean;
}): boolean {
  if (!input.embedded || input.dismissed) return false;
  if (!input.agents.length) return false;
  return !hasConnectedGateProvider(input.agents);
}

/** Claude Code + Codex rows for the gate, skipping any the server doesn't
 *  know about. */
export function embeddedConnectOptions(agents: ConnectAgentInfo[]): ConnectOption[] {
  const options: ConnectOption[] = [];
  for (const entry of GATE_PROVIDERS) {
    const agent = agents.find((item) => item.key === entry.kind);
    if (!agent) continue;
    options.push({
      provider: entry.provider,
      kind: entry.kind,
      label: entry.label,
      installed: binaryInstalled(agent),
      // Credentials are per provider: the ai-sdk sibling reports the same
      // login, so either kind being configured means this row is connected.
      configured: agents.some(
        (item) => entry.kinds.includes(item.key) && item.status.configured,
      ),
      canAutoSetup: agent.status.canAutoSetup,
    });
  }
  return options;
}
