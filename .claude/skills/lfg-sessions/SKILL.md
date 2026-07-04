---
name: lfg-sessions
description: See and drive the other lfg Claude Code sessions — list them, read what a session is doing, send it instructions, interrupt it, start/stop one, and track which session is currently in focus. Use whenever the user (especially over voice) refers to "my session", "the coding agent", "what is X working on", "tell it to…", "switch to…", or otherwise wants to manage work across sessions.
---

# Driving lfg sessions

You are running inside lfg and can orchestrate the other Claude Code sessions it
manages, over its local HTTP API. The API is on the same box, unauthenticated:

```
BASE=http://localhost:8766
```

Each session has a stable `sessionId` (UUID) and a human `title`. Work in terms of
the title with the user ("the auth session", "the one fixing billing"); resolve it
to a `sessionId` via the list. **Speak results in one short conversational line** —
you're being read aloud.

## Which session are we working on (focus pointer)

Persist the focused session so it survives across turns:

```bash
mkdir -p ~/.lfg
echo "<sessionId>" > ~/.lfg/active-session   # set focus
cat ~/.lfg/active-session 2>/dev/null         # recall focus
```

When the user names or implies a session ("let's work on the auth one"), resolve it
and write it to the pointer. When they say "it" / "that session" without naming one,
use the pointer. If the pointer is empty and it's ambiguous, list sessions and ask
which one (briefly).

## Capabilities

```bash
# List sessions. Only act on entries that have both sessionId and tmuxTarget.
curl -s $BASE/api/sessions | jq '.sessions[] | {sessionId, title, agent, tmuxName, tmuxTarget, assignedUser, lastUserText, lastActivityAt}'

# Read the full normalized transcript for context/history questions
curl -s "$BASE/api/sessions/<id>/messages?full=1" | jq -r '.messages[] | "\(.role)/\(.kind): \(.text)"'

# Quick status read only (recent tail)
curl -s "$BASE/api/sessions/<id>/messages?limit=20" | jq -r '.messages[] | "\(.role)/\(.kind): \(.text)"'

# Send an instruction / steer a session. Default mode is "steer": if the session
# is busy, it interrupts the running turn before delivering your text.
curl -s -X POST $BASE/api/sessions/<id>/send -H 'Content-Type: application/json' -d '{"text":"run the tests and report failures"}'

# Queue a non-urgent follow-up without interrupting active work.
curl -s -X POST $BASE/api/sessions/<id>/send -H 'Content-Type: application/json' -d '{"text":"when you are done, summarize status","mode":"queue"}'

# Interrupt a session's current turn (Escape — stop / redirect it)
curl -s -X POST $BASE/api/sessions/<id>/interrupt

# Answer a session BLOCKED on a permission / plan / trust selector by picking an
# option (0-based index, as listed in the live snapshot). This is the right call
# when the user says "approve that" / "tell it yes" — prefer it over `send`.
curl -s -X POST $BASE/api/sessions/<id>/answer -H 'Content-Type: application/json' -d '{"index":0}'

# Dismiss a blocked prompt without answering (Escape the selector)
curl -s -X POST $BASE/api/sessions/<id>/dismiss

# Check delivery status of things you sent
curl -s $BASE/api/sessions/<id>/queue | jq '.queue'

# List the repos a new session can be started in (resolve the user's words → a cwd)
curl -s $BASE/api/repos | jq '.repos[] | {name, cwd}'

# Start a new worker session directly (see "Creating a new session" below)
curl -s -X POST $BASE/api/sessions/new -H 'Content-Type: application/json' \
  -d '{"prompt":"investigate the failing deploy","cwd":"<repo cwd>","agent":"aisdk","model":"opus"}' \
  | jq '{sessionId, tmuxName, cwd, agent}'

# Spawn a cross-harness sub-agent under the current/focused session.
# Prefer this for delegation: it records parent/child relationships in lfg.
lfg subagent create --agent codex-aisdk --model gpt-5.5 --cwd "<repo cwd>" \
  --parent "<current sessionId>" --prompt "investigate the failing deploy"

# Track sub-agents spawned under the current/focused session.
lfg subagent list --parent "<current sessionId>"

# Close a session you started
curl -s -X POST $BASE/api/sessions/<id>/close
```

## Creating a new session

When the user says "start a new session", "spin up an agent", "open a session on
<repo>", "have something look at X" — create one with `/api/sessions/new`.

When YOU are delegating part of your own work to another harness, use
`lfg subagent create` instead. It still spawns a normal managed LFG session, but
it records the parent/child relationship so the frontend can nest it under you.
Examples: Claude can create Codex with `--agent codex-aisdk`; Codex can create
Claude with `--agent aisdk`; either can create OpenCode with `--agent opencode`.
Pass `--parent <sessionId>` when you know it. If omitted, the CLI falls back to
`LFG_SESSION_ID` or `~/.lfg/active-session`.

Do it in one shot from a single spoken request; only ask back if the repo is
genuinely ambiguous.

1. **Pick the repo (cwd).** This is the part that matters most over voice: if you
   omit `cwd` the session lands in lfg's OWN repo, which is almost never what the
   user means. List repos (`/api/repos`), match the user's words against `name`,
   and pass that repo's `cwd`. If they didn't name a repo and the focus pointer
   has one whose repo you can resolve, reuse it; otherwise read the repo names
   back and ask which one (briefly).
2. **Pick agent + model** (sensible defaults — only override if the user asks):
   - `agent`: `aisdk` (default) for a hands-off worker; `claude` for the
     interactive Claude CLI. (`codex` / `codex-aisdk` / `opencode` also exist.)
   - `model`: `opus` (default), or `sonnet` / `haiku` if they ask for faster/cheaper.
3. **Send the request.** Put the user's intent in `prompt`. Pass `cwd`, `agent`,
   `model`. Do NOT set `voice:true` — that flag is for spawning the voice
   orchestrator itself, not for ordinary worker sessions.
   ```bash
   curl -s -X POST $BASE/api/sessions/new -H 'Content-Type: application/json' \
     -d '{"prompt":"<what the user wants done>","cwd":"<repo cwd>","agent":"aisdk","model":"opus"}' \
     | jq '{sessionId, tmuxName, cwd, agent}'
   ```
4. **Make it the focus + confirm.** Write the returned `sessionId` to
   `~/.lfg/active-session`, then confirm in one line ("Started an Opus session in
   the auth repo — it's looking at the failing deploy now."). The `sessionId` can
   take a few seconds to come back; if it's null, the session still started —
   confirm by `tmuxName` and resolve the id from the list on the next turn.

## Creating a sub-agent

Use this when you need parallel help or a different harness:

```bash
lfg subagent models
lfg subagent create \
  --agent codex-aisdk \
  --model gpt-5.5 \
  --cwd "<repo cwd>" \
  --parent "<current sessionId>" \
  --prompt "Implement the parser refactor. Keep changes scoped and report test results."
lfg subagent list --parent "<current sessionId>"
```

Use `--agent aisdk --model opus` for a Claude worker, `--agent opencode` for an
OpenCode worker, or `--agent grok` / `--agent hermes` when those are configured.
After spawning, keep track with `lfg subagent list --parent <current sessionId>`.
Use the regular `/api/sessions/<child id>/messages` and `/send` calls above to
read or steer each child.

## Answering an agent's question (human-in-the-loop)

A background agent (e.g. the supervisor) may be **waiting on the user** for a
decision. These appear in the live snapshot under "PENDING QUESTIONS FOR YOU"
with a short `[id]`. When the user gives you their answer, relay it on their
behalf — the waiting agent unblocks the instant you do:

```bash
# List what's pending (also shown in the snapshot)
curl -s "$BASE/api/ask?status=open" | jq '.questions[] | {id, question, options}'

# Answer one — free text, or one of the offered options, in the user's words
curl -s -X POST $BASE/api/ask/<id>/answer -H 'Content-Type: application/json' \
  -d '{"answer":"yes, ship it","via":"voice"}'
```

Read the pending question out loud in one short line, capture the user's reply,
then POST it. Confirm briefly ("Done — told it to ship it.").

## Workflow

1. **Resolve** the target: focus pointer → else match the user's words against `title`
   / `lastUserText` from the list → else ask which one. Ignore list entries
   whose `sessionId` or `tmuxTarget` is null; they cannot be read/driven reliably.
   If `~/.lfg/active-session` points at a session that is absent from the
   current driveable list, treat the pointer as stale and choose from the list.
2. **Act**: use `/messages?full=1` when answering history/context questions,
   checking what was already decided, or briefing yourself before steering a
   session. Use `/messages?limit=20` only for a quick live status check. A status
   check must be read-only: do not `send` "check", "resume", or "status" into a
   busy session, because that cancels active Claude turns and sidechain Explore
   agents. Use `send` only when the user is intentionally redirecting the
   session; use `send` with `"mode":"queue"` for non-urgent follow-ups;
   use `interrupt` to stop; `new`/`close` to manage lifecycle.
3. **Confirm** in one line ("Sent. The auth session is running the tests now.").
4. Update the focus pointer whenever the working session changes.

## Cautions

- **Don't act on your own session.** You (the voice orchestrator) appear in the list
  too — your session runs in the lfg repo cwd and has the orchestrator brief. Never
  `send`/`interrupt`/`close` yourself. If unsure which is you, ask before closing
  anything.
- Default `send` is **steering** — it interrupts the running turn and feeds your
  text as the next instruction. For "when you finish..." instructions, pass
  `"mode":"queue"`. For status checks, read messages instead of sending.
- A session with no `tmuxTarget` is a ghost (orphaned transcript) — skip it.
- Reads are cheap; prefer a quick `/messages` check over guessing.
