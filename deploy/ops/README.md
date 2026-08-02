# lfg ops

Box-level operational helpers that aren't part of the app itself.

## `sakana-wg-router.sh`

WireGuard routing helper for the Sakana box. See `sakana-wg-router.md`.

## Removed: TTS failover and box-ensure

`lfg-tts-failover.*` and `lfg-box-ensure.*` used to keep the GPU box's TTS
engines healthy and probe `/api/voice/tts`. Both were removed along with the
text-to-speech feature — lfg no longer synthesizes speech, so there is nothing
for them to keep alive.

If you ever re-add self-hosted speech, note that `serve` routes voice through
`src/voice-providers.ts`, which only has hosted (ElevenLabs / OpenAI) adapters;
`TTS_UPSTREAM` / `STT_UPSTREAM` are not read anywhere. Wiring a GPU box back in
means adding an adapter there first, not setting an env var.
