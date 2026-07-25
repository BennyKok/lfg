// Demo seed for the artifacts + activity-feed prototype. Runs against the
// WORKTREE's data/ dir only — never prod. Seeds two managed sessions with
// transcript messages, staggered auto findings, and prints the dashboard
// session id so the driver can POST html artifacts over HTTP.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addManaged } from "../src/managed.ts";
import { indexSessionMessagesDirect } from "../src/transcript-index.ts";
import { setSessionTitle } from "../src/sessions.ts";
import { PATHS } from "../src/config.ts";

const now = Date.now();
const MIN = 60_000;

export const DASH_SID = "11111111-2222-4333-8444-555555555555";
const FIX_SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

addManaged({
  tmuxName: "lfg-demo-dashboard",
  cwd: PATHS.root,
  createdAt: now - 42 * MIN,
  agent: "aisdk",
  sessionId: DASH_SID,
  launchState: "running",
  project: "lfg",
  title: "Fleet metrics dashboard",
});
addManaged({
  tmuxName: "lfg-demo-whatsapp",
  cwd: PATHS.root,
  createdAt: now - 3 * 60 * MIN,
  agent: "codex-aisdk",
  sessionId: FIX_SID,
  launchState: "running",
  project: "lfg",
  title: "Fix WhatsApp reconnect loop",
});
await setSessionTitle(DASH_SID, "Fleet metrics dashboard");
await setSessionTitle(FIX_SID, "Fix WhatsApp reconnect loop");

indexSessionMessagesDirect(DASH_SID, [
  {
    id: "demo-user-1",
    role: "user",
    kind: "text",
    text: "Set up a live fleet dashboard — pull together active sessions, token burn, and open findings across all my agents, and keep it updating.",
    ts: now - 40 * MIN,
  },
  {
    id: "demo-asst-1",
    role: "assistant",
    kind: "text",
    text: "On it. I'll publish an HTML artifact with a stable id (`fleet-dashboard`) and re-publish it each minute with fresh data — the card below will update in place. You can also open it in its own tab; the URL always serves the latest version.",
    ts: now - 39 * MIN,
  },
]);

indexSessionMessagesDirect(FIX_SID, [
  {
    id: "demo-user-2",
    role: "user",
    kind: "text",
    text: "WhatsApp bridge drops the socket every ~2h and never reconnects. Find it and fix it.",
    ts: now - 3 * 60 * MIN,
  },
  {
    id: "demo-asst-2",
    role: "assistant",
    kind: "text",
    text: "Found it — the reconnect backoff caps at 6 retries and then gives up silently. Patched it to reset the counter on any successful frame and added jitter. Verifying now.",
    ts: now - 2.6 * 60 * MIN,
  },
]);

// Findings with staggered timestamps (write the JSONL directly so the feed
// shows a realistic spread instead of everything "just now").
const autoDir = join(PATHS.data, "auto");
mkdirSync(autoDir, { recursive: true });
const findings = [
  {
    id: "demof1",
    agentId: "security-audit",
    title: "New listener on :8899 since last audit",
    reasoning: ["Daily listener diff"],
    suggest: "Expected if the demo server is running; re-check after it stops.",
    severity: "med",
    createdAt: now - 26 * MIN,
    status: "open",
  },
  {
    id: "demof2",
    agentId: "repo-insights",
    title: "web bundle crossed 850 kB — consider code-splitting the orb",
    reasoning: ["Bundle watch"],
    suggest: "Dynamic-import eleven-orb; it's only used on the voice page.",
    severity: "low",
    createdAt: now - 95 * MIN,
    status: "open",
  },
] as const;
writeFileSync(
  join(autoDir, "findings.jsonl"),
  findings.map((f) => JSON.stringify(f)).join("\n") + "\n",
);

console.log(JSON.stringify({ ok: true, dashSid: DASH_SID, fixSid: FIX_SID }));
