import {
  spawnManagedAisdkSession,
  spawnManagedCodexAisdkSession,
  spawnManagedCursorSession,
  spawnManagedGrokSession,
  spawnManagedOpencodeAisdkSession,
  spawnManagedPiSession,
} from "../tmux.ts";
import type { CodingAgentKind } from "../coding-agents.ts";

const agent = process.argv[2] as CodingAgentKind | undefined;
const cwd = process.argv[3];
const resume = process.argv[4];

if (!agent || !cwd || !resume) {
  console.error("usage: recovery-launch-process <agent> <cwd> <resume-id>");
  process.exit(2);
}

const common = {
  name: `recovery-${agent}`,
  cwd,
  prompt: "continue",
  model: "test-model",
  omgSessionId: resume,
};

// These cases intentionally mirror /api/sessions/resume. Historical Claude
// and direct Codex sessions recover through their SDK harnesses; the other
// durable backends relaunch their own managed transport.
const result = agent === "claude" || agent === "aisdk"
  ? spawnManagedAisdkSession({
      ...common,
      model: "opus",
      sessionId: resume,
    })
  : agent === "codex" || agent === "codex-aisdk"
    ? spawnManagedCodexAisdkSession({
        ...common,
        key: `key-${resume}`,
        resume,
      })
    : agent === "opencode"
      ? spawnManagedOpencodeAisdkSession({
          ...common,
          key: `key-${resume}`,
          resume,
        })
      : agent === "pi"
        ? spawnManagedPiSession({
            ...common,
            key: `key-${resume}`,
            resume,
          })
        : agent === "grok"
          ? spawnManagedGrokSession({
              ...common,
              resume,
            })
          : agent === "cursor"
            ? spawnManagedCursorSession({
                ...common,
                nativeSessionId: resume,
              })
            : { ok: false, error: `${agent} has no durable recovery launcher` };

console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
