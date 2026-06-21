# lfg voice agent worker

`agent.py` is the LiveKit Agents worker that powers the in-app voice "orb": it
joins the LiveKit `voice` room and runs the STT → LLM (Claude brain ladder:
Haiku → Sonnet → Opus, all sharing the fleet tools) → TTS pipeline, bridging to
the lfg HTTP API (`/api/voice/*`, `/api/sessions/*`, `/api/repos`).

## Source of truth

This file in the repo is canonical. On the dev box the runtime path is a
**symlink** into this working tree:

```
/home/dev/livekit/agent.py -> /home/dev/repos/lfg/deploy/voice/agent.py
```

So editing the tracked file *is* editing what the service runs — just restart
the unit afterwards. Do not edit the runtime path directly; it would diverge.

## Runtime layout (NOT in the repo)

These live alongside the symlink in `/home/dev/livekit/` and are intentionally
untracked — they hold machine-local config and secrets:

- `creds.env` — `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` / `LIVEKIT_URL` /
  `LIVEKIT_WSS_PUBLIC`. Loaded by the unit via `EnvironmentFile=`. **Secret.**
- `livekit.yaml` — self-hosted livekit-server config.

`agent.py` reads all credentials from the environment — it hardcodes none.

## How it runs

systemd user unit `lk-voice-agent.service`:

```
EnvironmentFile=/home/dev/livekit/creds.env
Environment=LFG_BASE=http://127.0.0.1:8766
ExecStart=/home/dev/lk-agent/bin/python /home/dev/livekit/agent.py start
```

After editing `agent.py`:

```
systemctl --user restart lk-voice-agent.service
```

## Fleet tools the voice brain can call

`get_fleet_status`, `list_sessions`, `list_repos`, `create_session`,
`reply_to_session`, `answer_session_prompt`, `close_session`, and
`consult_advisor` (escalate to a stronger model). `create_session` +
`list_repos` let the orb spin up a new coding session by voice, in a named repo.
