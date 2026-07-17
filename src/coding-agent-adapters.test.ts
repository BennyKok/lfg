import { describe, expect, test } from "bun:test";
import {
  CODING_AGENT_ADAPTERS,
  COMMAND_FILE_AGENT_KINDS,
  SESSION_AGENT_KINDS,
  TMUX_AGENT_KINDS,
  isCommandFileAgent,
  isTmuxAgent,
} from "./coding-agent-adapters.ts";
import { CODING_AGENT_KINDS, CODING_AGENT_LABELS, isCodingAgentKind } from "./coding-agents.ts";
import { MODEL_OPTIONS, listModelCatalog, thinkingLevelsForAgent } from "./agent-catalog.ts";
import {
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedCodexSession,
  spawnManagedCopilotSession,
  spawnManagedCursorSession,
  spawnManagedGrokSession,
  spawnManagedOpencodeAisdkSession,
  spawnManagedSession,
  managedCopilotSessionArgv,
  managedCursorSessionArgv,
  cursorChatIdFromOutput,
  containedAgentCommand,
  parsePrompt,
} from "./tmux.ts";

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

const launchers = {
  claude: spawnManagedSession,
  aisdk: spawnManagedAisdkSession,
  codex: spawnManagedCodexSession,
  "codex-aisdk": spawnManagedCodexAisdkSession,
  opencode: spawnManagedOpencodeAisdkSession,
  grok: spawnManagedGrokSession,
  cursor: spawnManagedCursorSession,
  copilot: spawnManagedCopilotSession,
} satisfies Record<(typeof SESSION_AGENT_KINDS)[number], unknown>;

describe("coding agent adapter contract", () => {
  test("every launchable coding agent has one delivery transport", () => {
    const adapterKinds = Object.keys(CODING_AGENT_ADAPTERS);
    const transportKinds = [...TMUX_AGENT_KINDS, ...COMMAND_FILE_AGENT_KINDS];

    expect(sorted(adapterKinds)).toEqual(sorted(SESSION_AGENT_KINDS));
    expect(sorted(transportKinds)).toEqual(sorted(SESSION_AGENT_KINDS));
    expect(new Set(transportKinds).size).toBe(SESSION_AGENT_KINDS.length);

    for (const agent of SESSION_AGENT_KINDS) {
      const adapter = CODING_AGENT_ADAPTERS[agent];
      expect(adapter.managedLaunch).toBe(true);
      expect(isCommandFileAgent(agent)).toBe(adapter.transport === "command-file");
      expect(isTmuxAgent(agent)).toBe(adapter.transport === "tmux");
    }
  });

  test("visible coding-agent settings only reference real adapters", () => {
    for (const agent of CODING_AGENT_KINDS) {
      expect(isCodingAgentKind(agent)).toBe(true);
      expect(CODING_AGENT_ADAPTERS[agent]).toBeDefined();
      expect(CODING_AGENT_LABELS[agent]).toBeTruthy();
    }
  });

  test("model catalog covers every launchable adapter", () => {
    const catalog = listModelCatalog([]);
    const catalogByKey = new Map(catalog.map((item) => [item.key, item]));

    expect(sorted(catalogByKey.keys())).toEqual(sorted(SESSION_AGENT_KINDS));

    for (const agent of SESSION_AGENT_KINDS) {
      const option = MODEL_OPTIONS[agent];
      const item = catalogByKey.get(agent);
      expect(item, agent).toBeDefined();
      expect(option.models.length, agent).toBeGreaterThan(0);
      expect(option.defaultModel, agent).toBeTruthy();
      expect(item!.models.length, agent).toBeGreaterThan(0);
      expect(item!.defaultModel, agent).toBeTruthy();
      expect(item!.thinkingLevels).toEqual([...(thinkingLevelsForAgent(agent) ?? [])]);
    }
  });

  test("every launchable adapter has a managed session launcher", () => {
    for (const agent of SESSION_AGENT_KINDS) {
      expect(typeof launchers[agent], agent).toBe("function");
    }
  });

  test("cursor managed sessions launch without command approval prompts", () => {
    const argv = managedCursorSessionArgv({
      name: "lfg-test",
      cwd: "/tmp/lfg-test",
      prompt: "hello",
      model: "auto",
      lfgSessionId: "session-id",
      lfgUser: "user@example.com",
    });

    expect(argv).toContain("--yolo");
    expect(argv.slice(argv.indexOf("--sandbox"), argv.indexOf("--sandbox") + 2)).toEqual([
      "--sandbox",
      "disabled",
    ]);
    expect(argv).not.toContain("--model");
    expect(argv).toContain("LFG_SESSION_ID=session-id");
    expect(argv).toContain("LFG_USER=user@example.com");
  });

  test("cursor managed sessions resume their preallocated native chat", () => {
    const nativeSessionId = "74cb7cba-1e83-4c70-b0e0-248cce3ad5f4";
    const argv = managedCursorSessionArgv({
      name: "lfg-test",
      cwd: "/tmp/lfg-test",
      prompt: "hello",
      nativeSessionId,
    });

    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual([
      "--resume",
      nativeSessionId,
    ]);
    expect(cursorChatIdFromOutput(`Created chat: ${nativeSessionId}\n`)).toBe(nativeSessionId);
    expect(cursorChatIdFromOutput("chat creation failed")).toBeNull();
  });

  test("contained subagents run in the shared slice with cleanup and OOM priority", () => {
    const argv = containedAgentCommand(["/usr/bin/example-agent", "--task", "hello"], {
      name: "lfg-test",
      cwd: "/tmp/lfg-test",
      lfgSessionId: "session-id",
    });
    if (process.platform !== "linux") return;
    expect(argv).toContain("--slice=lfg-agents.slice");
    expect(argv).toContain("--property=KillMode=control-group");
    expect(argv).toContain("--property=OOMScoreAdjust=200");
    expect(argv).toContain("--setenv=LFG_SESSION_ID=session-id");
    expect(argv).toContain("--setenv=AGENT_BROWSER_SESSION=lfg-test");
    expect(argv.some((part) => part.startsWith("--setenv=DBUS_SESSION_BUS_ADDRESS="))).toBe(true);
    expect(argv.slice(-3)).toEqual(["/usr/bin/example-agent", "--task", "hello"]);
  });

  test("copilot managed sessions launch interactively and auto-execute the initial prompt", () => {
    const prev = process.env.LFG_COPILOT_ALLOW_ALL_TOOLS;
    delete process.env.LFG_COPILOT_ALLOW_ALL_TOOLS;
    try {
      const argv = managedCopilotSessionArgv({
        name: "lfg-test",
        cwd: "/tmp/lfg-test",
        prompt: "hello",
        model: "claude-sonnet-4.5",
        lfgSessionId: "session-id",
        lfgUser: "user@example.com",
      });

      // -p / --prompt puts Copilot into programmatic one-shot mode, which exits
      // after the first turn and breaks LFG's long-lived, steerable session
      // contract. -i / --interactive is the supported way to start an
      // interactive session AND auto-execute an initial prompt.
      expect(argv).not.toContain("-p");
      expect(argv).not.toContain("--prompt");
      const iAt = argv.indexOf("-i");
      expect(iAt).toBeGreaterThan(-1);
      expect(argv[iAt + 1]).toBe("hello");
      // --allow-all-tools is a broad tool-approval bypass. GitHub recommends
      // it only for isolated environments, so it stays opt-in.
      expect(argv).not.toContain("--allow-all-tools");
      expect(argv).toContain("--model");
      expect(argv).toContain("claude-sonnet-4.5");
      expect(argv).toContain("LFG_SESSION_ID=session-id");
      expect(argv).toContain("LFG_USER=user@example.com");
    } finally {
      if (prev === undefined) delete process.env.LFG_COPILOT_ALLOW_ALL_TOOLS;
      else process.env.LFG_COPILOT_ALLOW_ALL_TOOLS = prev;
    }
  });

  test("copilot managed sessions omit -i when no initial prompt is provided", () => {
    const argv = managedCopilotSessionArgv({
      name: "lfg-test",
      cwd: "/tmp/lfg-test",
    });
    expect(argv).not.toContain("-i");
    expect(argv).not.toContain("--interactive");
  });

  test("copilot --allow-all-tools is honored when the operator opts in", () => {
    const prev = process.env.LFG_COPILOT_ALLOW_ALL_TOOLS;
    process.env.LFG_COPILOT_ALLOW_ALL_TOOLS = "1";
    try {
      const argv = managedCopilotSessionArgv({
        name: "lfg-test",
        cwd: "/tmp/lfg-test",
      });
      expect(argv).toContain("--allow-all-tools");
    } finally {
      if (prev === undefined) delete process.env.LFG_COPILOT_ALLOW_ALL_TOOLS;
      else process.env.LFG_COPILOT_ALLOW_ALL_TOOLS = prev;
    }
  });

  test("cursor approval prompts are surfaced to the shared prompt UI", () => {
    const prompt = parsePrompt(`
 $  cd /home/dev/repos/lfg && git log --oneline -20 in .

 Run this command?
 Not in allowlist: cd, git log
  → Run (once) (y)
    Add Shell(cd), Shell(git log) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip (esc or n)
`);

    expect(prompt).toEqual({
      question: "Run this command?",
      options: [
        { index: 0, label: "Run once", selected: true },
        { index: 1, label: "Add command to allowlist", selected: false },
        { index: 2, label: "Run everything", selected: false },
        { index: 3, label: "Skip", selected: false },
      ],
    });
  });
});
