import { createHash, randomUUID } from "node:crypto";
import {
  readActionsSidecar,
  updateActionRow,
  reportPathFor,
  type ActionRow,
} from "../agents/runner.ts";
import {
  spawnManagedAisdkSession,
  tmuxHasSession,
  capturePane,
} from "../tmux.ts";
import { resolveTranscript } from "../sessions.ts";
import { enqueueTranscriptIndex, indexedRecentMessages } from "../transcript-index.ts";
import { addManaged } from "../managed.ts";
import { readEntry as readAisdkEntry } from "../aisdk-registry.ts";
import { USERS, assignUser } from "../users.ts";
import { PATHS } from "../config.ts";
import { resolveSessionCwd } from "../worktree.ts";

const PROJECT_REPO = process.env.LFG_REPO ?? PATHS.root;
// lfg's own checkout — where the send path (sendq.ts/tmux.ts) lives, and the
// repo the send-debug agent works in. The serve process runs from here.
const SELF_REPO = PATHS.root;
// Agent-dispatched sessions are owned by the operator so they show up under the
// same per-user filter as hand-started ones (first roster user = the operator).
const AGENT_OWNER = USERS[0];

function worktreeOperateLines(worktreePath: string, repoRoot: string, session: string): string {
  return `- You are in your dedicated worktree at \`${worktreePath}\` (branched from \`origin/main\`).
  Do ALL of your work here — never touch the shared checkout at \`${repoRoot}\`.
- When you are completely done (after the PR is merged), clean up:
  \`git -C ${repoRoot} worktree remove --force ${worktreePath}\`.`;
}

export type ActionResult = {
  ok: boolean;
  summary: string;
  data?: unknown;
};

// Every action is now just plain text. Executing it dispatches a coding agent
// (claude, no permission prompts) into the configured repo with the action text plus
// the surrounding report for context, and lets it figure out how to carry it
// out — file an issue, fix the bug and open a PR, post a note, whatever the
// text implies. No per-kind handlers, no allow-lists.
export async function executeAction(
  agentName: string,
  date: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ row: ActionRow; result: ActionResult }> {
  const rows = await readActionsSidecar(agentName, date);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`action ${id} not found in ${agentName}/${date}`);

  if (row.status === "done" && !opts.force) {
    return {
      row,
      result:
        row.result ?? { ok: true, summary: "already executed (cached)", data: undefined },
    };
  }
  if (row.status === "running") {
    throw new Error(`action ${id} is already running`);
  }

  await updateActionRow(agentName, date, id, { status: "running" });
  try {
    const result = await dispatchAgent(agentName, date, id, row.text);
    // Dispatched into its own tmux session — it keeps running there. Leave the
    // row "running"; the watcher flips it to done/failed when the session ends.
    if (result.ok) {
      const updated = await updateActionRow(agentName, date, id, {
        executedAt: new Date().toISOString(),
        result,
        session: (result.data as { session?: string })?.session,
        sessionId: (result.data as { sessionId?: string })?.sessionId,
      });
      return { row: updated!, result };
    }
    const updated = await updateActionRow(agentName, date, id, {
      status: "failed",
      executedAt: new Date().toISOString(),
      result,
      error: result.summary,
    });
    return { row: updated!, result };
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    const updated = await updateActionRow(agentName, date, id, {
      status: "failed",
      executedAt: new Date().toISOString(),
      error: summary,
      result: { ok: false, summary },
    });
    return { row: updated!, result: { ok: false, summary } };
  }
}

async function dispatchAgent(
  agentName: string,
  date: string,
  id: string,
  text: string,
): Promise<ActionResult> {
  let reportContext = "";
  try {
    reportContext = await Bun.file(reportPathFor(agentName, date)).text();
  } catch {
    // report missing — proceed with just the action text
  }

  // Name the tmux session up front so the brief can reference it for the
  // worktree/branch — both must agree so the agent's worktree is uniquely
  // its own (one per dispatched action).
  const session = `agent_${sanitize(agentName)}_${id.slice(0, 6)}`;
  const cwdResolved = resolveSessionCwd(PROJECT_REPO, session, { selfRepo: SELF_REPO });
  if (!cwdResolved.ok) {
    return { ok: false, summary: `failed to prepare worktree: ${cwdResolved.error}` };
  }
  const { cwd, worktree } = cwdResolved;

  const operate = worktree
    ? worktreeOperateLines(worktree.path, worktree.repoRoot, session)
    : `- You are in the project repo at \`${cwd}\`. Other agents may share this checkout — commit with explicit pathspecs only.`;

  const prompt = `You are an automated action agent dispatched by the lfg \`${agentName}\` report (${date}).

# Action to carry out
${text}

# How to operate
${operate}
- Carry the action out end-to-end as a real code change in your worktree: make
  the fix, commit, push, open a PR (\`gh pr create\`), and then **merge it**
  (\`gh pr merge --squash --delete-branch\`; use \`--auto\` if branch protection
  requires checks to pass first). Do NOT just open the PR and stop, and never
  commit directly to main.
- Keep changes minimal and follow the repo's CLAUDE.md conventions.
- If the action is genuinely ambiguous or unsafe to automate, do NOT force it —
  explain why and stop without merging.
- On the LAST line of your output, print a one-line result starting with
  \`RESULT:\` summarizing what you did (include the PR URL and merge status).

${reportContext ? `# Full report for context\n${reportContext.slice(0, 12000)}` : ""}`;

  // Spawn the action agent through the AI-SDK harness (mirrors serve.ts's
  // "aisdk" create path) instead of the claude CLI + brief-file path: mint the
  // sessionId up front (it IS the transcript id) and hand the brief straight in
  // as the harness prompt — no temp brief file, no pidfile/pane discovery.
  const sessionId = randomUUID();
  const spawned = spawnManagedAisdkSession({
    name: session,
    cwd,
    prompt,
    model: "opus",
    sessionId,
  });
  if (!spawned.ok) {
    return { ok: false, summary: `failed to start agent session: ${spawned.error ?? "unknown"}` };
  }
  // Same lifecycle as a user-created session: register it as managed (clean
  // teardown, badge) and tag it to the operator so it shows under the filter.
  addManaged({
    tmuxName: session,
    cwd,
    createdAt: Date.now(),
    agent: "aisdk",
    repoRoot: worktree?.repoRoot,
    worktreeBranch: worktree?.branch,
  });
  assignUser(session, AGENT_OWNER);

  // Wait for the harness to register so the session is listable; the sessionId
  // is already known (we minted it), so the UI can deep-link immediately.
  for (let i = 0; i < 20 && !readAisdkEntry(sessionId); i++) await Bun.sleep(250);

  watchAgentSession(agentName, date, id, session, sessionId).catch(() => {});

  return {
    ok: true,
    summary: `dispatched into tmux session ${session} — drive it in the session list`,
    data: { session, sessionId },
  };
}

// Carry out SEVERAL selected actions inside ONE agent session, instead of
// fanning out one tmux/worktree/PR per action. The selected rows are bundled
// into a single brief (a numbered task list) and handed to a single claude in a
// single worktree — it works through them all, grouping related tasks into
// shared commits/PRs as it sees fit. Every selected row points at the same
// session/sessionId and is finalized together when the agent prints RESULT:.
export async function executeActionsCombined(
  agentName: string,
  date: string,
  ids: string[],
  opts: { force?: boolean } = {},
): Promise<{ rows: ActionRow[]; result: ActionResult }> {
  if (ids.length === 0) throw new Error("no actions selected");
  if (ids.length === 1) {
    const { row, result } = await executeAction(agentName, date, ids[0], opts);
    return { rows: [row], result };
  }

  const all = await readActionsSidecar(agentName, date);
  const selected = ids.map((id) => {
    const row = all.find((r) => r.id === id);
    if (!row) throw new Error(`action ${id} not found in ${agentName}/${date}`);
    return row;
  });

  for (const row of selected) {
    if (row.status === "running") throw new Error(`action ${row.id} is already running`);
    if (row.status === "done" && !opts.force)
      throw new Error(`action ${row.id} already executed — pass force to re-run`);
  }

  for (const row of selected) {
    await updateActionRow(agentName, date, row.id, { status: "running" });
  }

  try {
    const result = await dispatchCombinedAgent(agentName, date, selected);
    const session = (result.data as { session?: string })?.session;
    const sessionId = (result.data as { sessionId?: string })?.sessionId;
    if (result.ok) {
      const rows: ActionRow[] = [];
      for (const row of selected) {
        const updated = await updateActionRow(agentName, date, row.id, {
          executedAt: new Date().toISOString(),
          result,
          session,
          sessionId,
        });
        if (updated) rows.push(updated);
      }
      return { rows, result };
    }
    const rows: ActionRow[] = [];
    for (const row of selected) {
      const updated = await updateActionRow(agentName, date, row.id, {
        status: "failed",
        executedAt: new Date().toISOString(),
        result,
        error: result.summary,
      });
      if (updated) rows.push(updated);
    }
    return { rows, result };
  } catch (e) {
    const summary = e instanceof Error ? e.message : String(e);
    const rows: ActionRow[] = [];
    for (const row of selected) {
      const updated = await updateActionRow(agentName, date, row.id, {
        status: "failed",
        executedAt: new Date().toISOString(),
        error: summary,
        result: { ok: false, summary },
      });
      if (updated) rows.push(updated);
    }
    return { rows, result: { ok: false, summary } };
  }
}

async function dispatchCombinedAgent(
  agentName: string,
  date: string,
  rows: ActionRow[],
): Promise<ActionResult> {
  let reportContext = "";
  try {
    reportContext = await Bun.file(reportPathFor(agentName, date)).text();
  } catch {
    // report missing — proceed with just the action texts
  }

  // One session/worktree for the whole batch. Derive a stable handle from the
  // member ids so a re-run of the same selection reuses a deterministic name.
  const combinedId = createHash("sha256")
    .update(rows.map((r) => r.id).join("|"))
    .digest("hex")
    .slice(0, 6);
  const session = `agent_${sanitize(agentName)}_multi_${combinedId}`;
  const cwdResolved = resolveSessionCwd(PROJECT_REPO, session, { selfRepo: SELF_REPO });
  if (!cwdResolved.ok) {
    return { ok: false, summary: `failed to prepare worktree: ${cwdResolved.error}` };
  }
  const { cwd, worktree } = cwdResolved;

  const taskList = rows.map((r, i) => `${i + 1}. ${r.text}`).join("\n");

  const operate = worktree
    ? worktreeOperateLines(worktree.path, worktree.repoRoot, session)
    : `- You are in the project repo at \`${cwd}\`. Other agents may share this checkout — commit with explicit pathspecs only.`;

  const prompt = `You are an automated action agent dispatched by the lfg \`${agentName}\` report (${date}). You have been handed **${rows.length} actions** to carry out together in a SINGLE working session.

# Actions to carry out (work through ALL of them)
${taskList}

# How to operate
${operate}
- Work through EVERY action in the list above end-to-end as real code changes.
  Group **related** actions into a single commit + PR; keep **unrelated** ones
  as separate commits/PRs within this one worktree. Open each PR (\`gh pr
  create\`) and then **merge it** (\`gh pr merge --squash --delete-branch\`; use
  \`--auto\` if branch protection requires checks first). Do NOT just open PRs
  and stop, and never commit directly to main.
- Keep changes minimal and follow the repo's CLAUDE.md conventions.
- If a specific action is genuinely ambiguous or unsafe to automate, skip just
  that one (explain why) and continue with the rest — don't force it.
- On the LAST line of your output, print a one-line result starting with
  \`RESULT:\` summarizing what you did for each action (include PR URLs + merge
  status).

${reportContext ? `# Full report for context\n${reportContext.slice(0, 12000)}` : ""}`;

  // Spawn the combined-batch agent through the AI-SDK harness (same as the
  // single-action path): mint the sessionId and pass the batch brief directly.
  const sessionId = randomUUID();
  const spawned = spawnManagedAisdkSession({
    name: session,
    cwd,
    prompt,
    model: "opus",
    sessionId,
  });
  if (!spawned.ok) {
    return { ok: false, summary: `failed to start agent session: ${spawned.error ?? "unknown"}` };
  }
  addManaged({
    tmuxName: session,
    cwd,
    createdAt: Date.now(),
    agent: "aisdk",
    repoRoot: worktree?.repoRoot,
    worktreeBranch: worktree?.branch,
  });
  assignUser(session, AGENT_OWNER);

  for (let i = 0; i < 20 && !readAisdkEntry(sessionId); i++) await Bun.sleep(250);

  watchCombinedSession(agentName, date, rows.map((r) => r.id), session, sessionId).catch(() => {});

  return {
    ok: true,
    summary: `dispatched ${rows.length} actions into one tmux session ${session} — drive it in the session list`,
    data: { session, sessionId },
  };
}

// Same lifecycle as watchAgentSession, but finalizes every row in the batch
// when the single agent prints its RESULT: line (or the session ends).
async function watchCombinedSession(
  agentName: string,
  date: string,
  ids: string[],
  session: string,
  sessionId: string | null,
): Promise<void> {
  await Bun.sleep(3000);
  const finalize = async (summary: string) => {
    for (const id of ids) {
      await updateActionRow(agentName, date, id, {
        status: "done",
        executedAt: new Date().toISOString(),
        result: { ok: true, summary, data: { session, sessionId } },
      });
    }
  };
  for (let i = 0; i < 720; i++) {
    // ~60 min cap
    if (!tmuxHasSession(session)) {
      await finalize((await readResultLine(sessionId)) ?? "agent session ended");
      return;
    }
    const result = await readResultLine(sessionId);
    if (result) {
      await finalize(result);
      return;
    }
    await Bun.sleep(5000);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

// Spawn a coding agent to debug a failed outbound send. A message ends up
// "failed" when it never left the target session's input box after retries (a
// swallowed Enter, a stranded composer, an overlay we didn't recognize, a cold
// TUI dropping keys, …) — all bugs in lfg's own send path (sendq.ts/tmux.ts).
// This dispatches an agent INTO the lfg checkout with the exact failure
// context (the message, the error, a live capture of the stuck pane) so it can
// reproduce, fix the root cause, and report. Unlike the report-action agent it
// works in lfg's single live checkout (no worktree/PR ceremony) and the serve
// process must be restarted to pick up a fix.
export async function dispatchSendFixAgent(opts: {
  failSessionId: string;
  failTarget: string | null;
  failTitle?: string | null;
  msgId: string;
  msgText: string;
  msgError?: string;
  msgAttempts: number;
}): Promise<ActionResult> {
  const session = `debug_send_${opts.msgId.slice(0, 6)}`;

  // Snapshot the stuck pane so the agent sees the TUI state the send gave up
  // against (overlay up? text stranded in the composer? a selector open?).
  const pane = opts.failTarget ? capturePane(opts.failTarget) : null;

  // A few recent transcript turns give the agent the conversational context the
  // failed message belonged to.
  let convo = "";
  try {
    const tp = await resolveTranscript(opts.failSessionId);
    if (tp) {
      enqueueTranscriptIndex(tp, opts.failSessionId);
      const msgs = await indexedRecentMessages(tp, opts.failSessionId, 8);
      convo = msgs
        .filter((m) => m.kind === "text" && m.text)
        .map((m) => `- ${m.role}: ${m.text!.replace(/\s+/g, " ").slice(0, 200)}`)
        .join("\n");
    }
  } catch {
    // transcript unavailable — proceed without it
  }

  const prompt = `You are a debugging agent dispatched by lfg because an outbound message to a Claude Code session **failed to send**. Your job: find out why this send failed and fix the bug in lfg's send path.

# The failed send
- Target session: ${opts.failTitle || opts.failSessionId} (tmux pane \`${opts.failTarget ?? "unknown"}\`)
- Delivery error: ${opts.msgError || "(none recorded)"}
- Attempts made: ${opts.msgAttempts}
- Message text the user tried to send:
"""
${opts.msgText}
"""

# Live capture of the stuck pane at failure time
${pane ? "```\n" + pane.slice(-3000) + "\n```" : "(pane could not be captured — the session may have ended)"}

# Recent conversation in that session (for context)
${convo || "(unavailable)"}

# How to operate
- You are in the lfg repo at ${SELF_REPO} (this is lfg's own single live checkout — work in it directly, do NOT create a worktree).
- The send path is \`src/sendq.ts\` (the confirmed-delivery queue: type → confirm text appears → Enter → confirm text leaves the box → retry) and \`src/tmux.ts\` (the low-level send-keys/capture primitives, prompt + rating-overlay detection, \`inputBoxText\`). Read both first.
- Diagnose the ROOT CAUSE from the error + pane capture above. Common culprits: an overlay/selector shape \`feedbackPromptOpen\`/\`parsePrompt\` doesn't recognize (so Enter gets swallowed), \`inputBoxText\` failing to find the composer (so the needle check never confirms), a cold/busy TUI dropping typed keys, or the message containing characters that break \`tmux send-keys -l\`.
- If it's a genuine lfg bug, fix it minimally in keeping with the file's existing style and comments. Then apply the fix: \`systemctl --user restart lfg.service\` (the serve process is long-lived — a code change has NO effect until it restarts). Confirm it comes back up: \`systemctl --user is-active lfg.service\`.
- After verifying, commit and push (this repo commits to main directly): \`git -C ${SELF_REPO} add -A && git -C ${SELF_REPO} commit -m "..." && git -C ${SELF_REPO} push\`.
- If the failure was transient (a one-off swallowed key, the target session had since exited) and there is no code bug to fix, do NOT invent a change — explain what happened and stop.
- On the LAST line of your output, print a one-line result starting with \`RESULT:\` summarizing the root cause and what you changed (or why no change was needed).`;

  // Spawn the send-debug agent through the AI-SDK harness (same pattern as the
  // report-action agents): mint the sessionId and hand the brief in directly.
  const sessionId = randomUUID();
  const spawned = spawnManagedAisdkSession({
    name: session,
    cwd: SELF_REPO,
    prompt,
    model: "opus",
    sessionId,
  });
  if (!spawned.ok) {
    return { ok: false, summary: `failed to start debug session: ${spawned.error ?? "unknown"}` };
  }
  addManaged({ tmuxName: session, cwd: SELF_REPO, createdAt: Date.now(), agent: "aisdk" });
  assignUser(session, AGENT_OWNER);

  for (let i = 0; i < 20 && !readAisdkEntry(sessionId); i++) await Bun.sleep(250);

  return {
    ok: true,
    summary: `dispatched send-debug agent into tmux session ${session}`,
    data: { session, sessionId },
  };
}

// Watch a dispatched session and finalize the action row when the agent is
// done. An interactive `claude` doesn't exit when it finishes a task — it sits
// at the prompt — so completion is signalled by the agent printing a `RESULT:`
// line (per the brief), not by the session dying. The session is left alive so
// the user can keep driving it. We stop watching if the session is gone or
// after a long cap (the row then stays "running" and the live session shows
// its true state).
async function watchAgentSession(
  agentName: string,
  date: string,
  id: string,
  session: string,
  sessionId: string | null,
): Promise<void> {
  await Bun.sleep(3000);
  const finalize = async (summary: string) => {
    await updateActionRow(agentName, date, id, {
      status: "done",
      executedAt: new Date().toISOString(),
      result: { ok: true, summary, data: { session, sessionId } },
    });
  };
  for (let i = 0; i < 720; i++) {
    // ~60 min cap
    if (!tmuxHasSession(session)) {
      await finalize((await readResultLine(sessionId)) ?? "agent session ended");
      return;
    }
    const result = await readResultLine(sessionId);
    if (result) {
      await finalize(result);
      return;
    }
    await Bun.sleep(5000);
  }
}

// Scan the agent's transcript for the last `RESULT:` line it printed.
async function readResultLine(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const tp = await resolveTranscript(sessionId);
    if (!tp) return null;
    enqueueTranscriptIndex(tp, sessionId);
    const msgs = await indexedRecentMessages(tp, sessionId, 80);
    const line = msgs
      .filter((m) => m.role === "assistant" && m.kind === "text")
      .flatMap((m) => (m.text || "").split("\n"))
      .reverse()
      .find((l) => l.trim().startsWith("RESULT:"));
    return line ? line.replace(/^.*RESULT:\s*/, "").trim() : null;
  } catch {
    return null;
  }
}
