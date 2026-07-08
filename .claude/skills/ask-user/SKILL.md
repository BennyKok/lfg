---
name: ask-user
description: Ask the human a question without blocking. Use when a decision genuinely needs the user's call (irreversible actions, ambiguous intent, competing trade-offs, anything risky) and you cannot reasonably decide alone. Raises a push notification; the answer is pushed back into your session as a new user message whenever the user replies.
---

# Asking the user (human-in-the-loop)

You run headless, but some calls are not yours to make. When you hit one, ask
the human instead of guessing. Asking is **fire-and-forget**: you send the
question, get an id back immediately, and carry on (or end your turn). There is
no waiting, no polling, no timeout — the user may answer hours later, and their
reply is injected into your session as a new user message.

## When to ask

Ask only when it's worth interrupting someone:

- Irreversible or risky actions (deploying, deleting, force-pushing, spending).
- Genuinely ambiguous intent where the wrong guess wastes real work.
- A judgement call between trade-offs only the user can weigh.

Do **not** ask for things you can safely determine yourself, and never ask more
than one question per run. Silence is still the default — most runs ask nothing.

## How to ask

Call the MCP tool `lfg_ask_user`:

- `question` — plain concise prose. Lead with the decision in one sentence;
  at most a couple of short context lines after. **No markdown headings, no
  walls of text** — this renders on a small card.
- `options` — optional short one-tap suggestions (the user may still type
  free text, so handle any answer).
- `sessionId` / `user` — usually omit; they default to your session and its
  assigned user.

Fallback without MCP (rare):

```bash
curl -s -X POST http://localhost:8766/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"…","options":["…"],"sessionId":"<your session id>","pushback":true,"wait":false}'
```

## After asking

- **Do not block, poll, or sleep.** Continue other safe work or end your turn.
- Do **not** take the action you asked about until the answer arrives.
- The answer arrives as a user message starting with `[ask-user answer <id>]`.
  It is the user's decision in their own words — honour it even when it differs
  from your recommendation.
