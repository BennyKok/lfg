# lfg voice on Modal (prototype)

Serverless Chatterbox TTS + Whisper STT, to replace the always-on Novita GPU box
(no capacity fights, no SSH tunnel, no start/stop timers). Scale-to-zero: you pay
~$0.001 per conversational turn and ~nothing while idle.

`voice_app.py` exposes one token-protected endpoint matching serve's existing
proxy contract, so wiring lfg in is a one-line `.env` change:

```
GET  /health            -> {"ok": true}
POST /tts  {text,voice} -> audio/wav         (Chatterbox)
POST /stt  <wav bytes>  -> {"text": "..."}   (faster-whisper)
```

## 1. Authenticate (one-time, needs a Modal account)
```sh
export PATH="$HOME/.local/bin:$PATH"
modal token new          # opens a browser; writes ~/.modal.toml
# …or non-interactive:
modal token set --token-id <id> --token-secret <secret>
```

## 2. (Optional) set the API token the endpoint requires
```sh
modal secret create lfg-voice TTS_TOKEN=855a8ce9434837931b2a1a8d01e368a9f6af7b2e6fcbd055
```
(Omit to leave the endpoint open for a quick probe.)

## 3. Deploy
```sh
modal deploy deploy/modal/voice_app.py
```
Prints a base URL like:
`https://<workspace>--lfg-voice-voice-web.modal.run`

First deploy builds the image (downloads Chatterbox + Whisper weights into the
image layer) — a few minutes, once.

## 4. Benchmark (cold-start + warm synth latency)
```sh
deploy/modal/bench.sh https://<workspace>--lfg-voice-voice-web.modal.run
```

## 5. Wire lfg at it (when you like the numbers)
In `/home/dev/repos/lfg/.env`:
```
TTS_UPSTREAM=https://<workspace>--lfg-voice-voice-web.modal.run
STT_UPSTREAM=https://<workspace>--lfg-voice-voice-web.modal.run
```
`systemctl --user restart lfg-serve.service`, then verify playback. serve appends
`/tts` and `/stt` to the upstream, which these routes already match.

## Cost / latency knobs (`voice_app.py`)
- `gpu=` — `L4` ($0.80/hr, default) · `A10G` ($1.10/hr) · `A100-40GB` (overkill).
- `min_containers=0` — pure scale-to-zero. Set `1` to kill cold starts (~$/hr while warm).
- `scaledown_window=300` — stay warm 5 min after last use, then →0.
- `enable_memory_snapshot=True` — restores warm in ~1–3s instead of ~20–30s.
- `LFG_WHISPER_SIZE` env — `tiny|base|small|medium` (accuracy vs speed).

## Caveats
- **Region:** Modal is US/EU, not Asia — adds ~150–200ms RTT for a HKT user vs a
  HK box. Fine for TTS playback; matters for snappy full-duplex.
- **Chatterbox bug:** this runs the same Chatterbox engine the voice-fixes session
  is mid-fixing; if their streaming variant emits no audio, that's a code bug to
  fix in `generate()` here too — Modal just makes iterating faster.
