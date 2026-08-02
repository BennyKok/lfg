# Sakana egress proxy (Modal)

`api.sakana.ai` returns a Google-edge 403 when called directly from the Hetzner
box. These two scripts are one of the two documented workarounds; the other is
the WireGuard route in `../ops/sakana-wg-router.md`.

- `sakana_probe.py` — checks whether a given egress path reaches the API.
- `sakana_proxy.py` — Modal-hosted forwarder that lfg can point at instead.

Relevant config: `SAKANA_API_KEY` in `.env` (see `.env.example`); models route
through `src/agent-catalog.ts`.

> The voice half of this directory (`voice_app.py`, `scale.py`, `bench.sh` —
> serverless Chatterbox TTS + Whisper STT) was removed with the text-to-speech
> feature. lfg no longer synthesizes speech, and `TTS_UPSTREAM` / `STT_UPSTREAM`
> are not read anywhere.
