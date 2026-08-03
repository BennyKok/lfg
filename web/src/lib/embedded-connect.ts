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
    /** User-owned browser/CLI login. Runtime API keys do not satisfy this. */
    accountConnected?: boolean;
    canAutoSetup: boolean;
    checks: { label: string; ok: boolean; detail?: string }[];
  };
};

export type ConnectOption = {
  /** Auth provider the CLI login belongs to. */
  provider: "claude" | "codex" | "grok";
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

export type ToolConnectOption = {
  key: "github";
  label: string;
  detail: string;
  installed: boolean;
  connected: boolean;
};

/** Providers the embedded gate recognizes, in display order. Hidden entries
 *  still count as connected so an existing Grok user is never sent back
 *  through first-run setup; visibility is a product choice, not an auth fork. */
const GATE_PROVIDERS: {
  provider: "claude" | "codex" | "grok";
  label: string;
  showInOnboarding: boolean;
  /** Actual roster keys that can drive this provider's install/login flow. */
  kinds: string[];
}[] = [
  {
    provider: "claude",
    label: "Claude Code",
    showInOnboarding: true,
    kinds: ["claude", "aisdk"],
  },
  {
    provider: "codex",
    label: "Codex",
    showInOnboarding: true,
    kinds: ["codex", "codex-aisdk"],
  },
  { provider: "grok", label: "Grok", showInOnboarding: false, kinds: ["grok"] },
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
 * True when one of the providers offered by the framed gate is connected.
 *
 * Deliberately NOT "any configured agent": an agent-lfg image ships pi bundled
 * (and can carry OpenCode/Copilot creds from the image), so `agents.some(
 * configured)` would report a fresh Computer as ready and skip the connect
 * prompt the user still needs. Someone genuinely working on one of those
 * providers takes the gate's skip link instead.
 */
export function hasConnectedGateProvider(agents: ConnectAgentInfo[]): boolean {
  return agents.some(
    (agent) => GATE_PROVIDER_KINDS.has(agent.key) && agent.status.accountConnected === true,
  );
}

/**
 * Show the embedded connect gate only when we positively know the box has
 * none of the offered providers connected. An empty roster means the bootstrap
 * payload never arrived (or failed) — gating on that would trap the user behind
 * a card we cannot resolve, so it stays closed.
 *
 * `bare` closes it outright. The gate replaces the ENTIRE tree — it returns
 * before the shell — which is right for a framed full app (the frame's whole
 * job is to run sessions, and it can't run one without an agent) and wrong for
 * a host that mounted a single settings page. There, the user asked to change
 * a setting, not to onboard: a host mounting Settings on a box with no
 * connected agent got "Connect a coding agent" where its settings should have
 * been, with no way to reach the page at all. A bare surface renders the page
 * it was asked for; the host owns its own onboarding.
 */
export function shouldShowEmbeddedConnectGate(input: {
  embedded: boolean;
  agents: ConnectAgentInfo[];
  dismissed?: boolean;
  bare?: boolean;
}): boolean {
  if (input.bare) return false;
  if (!input.embedded || input.dismissed) return false;
  if (!input.agents.length) return false;
  return !hasConnectedGateProvider(input.agents);
}

/** Browser-loginable provider rows for the gate, skipping any the server
 *  doesn't know about. */
export function embeddedConnectOptions(agents: ConnectAgentInfo[]): ConnectOption[] {
  const options: ConnectOption[] = [];
  for (const entry of GATE_PROVIDERS) {
    if (!entry.showInOnboarding) continue;
    const agent = entry.kinds
      .map((kind) => agents.find((item) => item.key === kind))
      .find((item) => item !== undefined);
    if (!agent) continue;
    options.push({
      provider: entry.provider,
      kind: agent.key,
      label: entry.label,
      installed: binaryInstalled(agent),
      // Runtime API keys make the agent usable, but only a user-owned account
      // login completes this first-run connection step.
      configured: agents.some(
        (item) => entry.kinds.includes(item.key) && item.status.accountConnected === true,
      ),
      canAutoSetup: agent.status.canAutoSetup,
    });
  }
  return options;
}
