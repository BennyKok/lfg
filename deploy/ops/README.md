# lfg ops — TTS failover

Keeps the self-hosted GPU TTS engines healthy across the box's daily overnight
stop/start.

> **Status: `TTS_UPSTREAM` is no longer read by lfg.** Its only reader was the
> `/api/voice/identify` route, removed with the phone-call feature. `serve`
> routes `/api/voice/tts` through `src/voice-providers.ts` (ElevenLabs / OpenAI
> only). Until a self-hosted adapter is added there, `lfg-tts-failover.timer`
> only keeps the GPU engines warm — rewriting `TTS_UPSTREAM` changes nothing —
> so you may want to disable the timer.

## Why
This was written when TTS was proxied by `serve` (`/api/voice/tts`) to
`TTS_UPSTREAM` in `.env`. Two engines run on the GPU box:

- **CosyVoice2 `:8088`** — known-good (24 kHz PCM, what the worker's `LfgTTS`
  adapter expects).
- **Chatterbox `:8090`** — the voice-fixes session's engine, mid-migration to a
  streaming variant. While broken it returns HTTP 200 but emits **zero audio**
  and leaves spoken replies silently failing.

## What `lfg-tts-failover.sh` does (each morning, after box start)
1. Waits for CosyVoice2 `:8088` to be healthy (starts the box itself if needed).
2. Probes Chatterbox `:8090` — **uses it only if it returns real audio**;
   otherwise points `TTS_UPSTREAM` back at `:8088`.
3. Restarts `serve` and verifies real audio end-to-end through the proxy.
4. Logs to `~/.local/state/lfg-tts-failover.log`.

It edits **only** the `TTS_UPSTREAM` line in `.env` — never `src/commands/serve.ts`,
`deploy/gpu-stt/*`, or the on-box `chatterbox_*.py`.

## Install (systemd user units)
```sh
ln -sf "$PWD/lfg-tts-failover.service" ~/.config/systemd/user/lfg-tts-failover.service
ln -sf "$PWD/lfg-tts-failover.timer"   ~/.config/systemd/user/lfg-tts-failover.timer
systemctl --user daemon-reload
systemctl --user enable --now lfg-tts-failover.timer
# also ensure the box actually starts each morning:
systemctl --user enable --now lfg-stt-start.timer
```

Schedule: box starts `lfg-stt-start.timer` @ 03:00 UTC; failover runs @ 03:10 UTC
(11:10 HKT).
