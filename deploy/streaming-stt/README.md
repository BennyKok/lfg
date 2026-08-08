# Streaming STT — NeMo cache-aware FastConformer (English)

The streaming half of a high-performance realtime voice path. Replaces batch
whisper/Parakeet with a model that emits transcripts **as the user speaks**.

> **Status: not currently wired into OMG.** This server's only client was the
> LiveKit voice worker (`deploy/voice/agent.py`), which was removed along with
> the phone-call feature. `serve` reads neither `STT_UPSTREAM` nor `STT_WS_URL`
> — `/api/voice/stt` and `/api/voice/stt-stream` go through
> `src/voice-providers.ts`, which today only has ElevenLabs and OpenAI adapters.
> Kept here because the server itself is still good; re-wiring it means adding a
> self-hosted adapter to `voice-providers.ts`.

```
client  ──16kHz PCM ws──▶  server.py  ──▶  NeMo
   ▲                                        │
   └────── {"partial"|"final","text"} ◀─────┘
```

## Why this model
Whisper is an attention encoder-decoder over a fixed window — it can't truly
stream. **Cache-aware streaming FastConformer** is frame-synchronous: it keeps
encoder cache state across chunks and emits partial hypotheses with low latency.
It's the same FastConformer family as the Parakeet you already run, so it stays
on the existing NeMo GPU box — only the checkpoint and the per-chunk loop change.

Recommended checkpoint (English, multi-lookahead):
`stt_en_fastconformer_hybrid_large_streaming_multi`.

## Deploy
On the GPU box (not the dev box):

```sh
python -m venv /opt/streaming-stt/venv
/opt/streaming-stt/venv/bin/pip install -r requirements.txt
STT_MODEL=stt_en_fastconformer_hybrid_large_streaming_multi \
STT_WS_HOST=0.0.0.0 STT_WS_PORT=8088 \
/opt/streaming-stt/venv/bin/python server.py
```

Then enable it on the voice agent (lk-agent host) by setting **one** env var and
restarting the worker — no other agent change required:

```sh
STT_WS_URL=ws://<gpu-box-or-tailnet-host>:8088
```

`STT_WS_URL` was read by the removed LiveKit worker; nothing in OMG reads it
today.

## Env knobs (server.py)
| Var | Default | Notes |
|---|---|---|
| `STT_MODEL` | `..._streaming_multi` | NeMo cache-aware streaming checkpoint |
| `STT_WS_HOST` / `STT_WS_PORT` | `0.0.0.0` / `8088` | listen address |
| `STT_DEVICE` | `cuda` if available | inference device |
| `STT_LOOKAHEAD` | `1` | index into the checkpoint's multi-lookahead list; lower = lower latency, slightly lower accuracy |

## ⚠️ Validate on the box before prod
`server.py` follows NeMo's documented cache-aware streaming pattern
(`examples/asr/asr_cache_aware_streaming/`), but the streaming API surface
**varies across NeMo releases and checkpoints**. Confirm these against your
installed NeMo before trusting it:

1. **Cache setup** — `encoder.setup_streaming_params()` /
   `set_default_att_context_size(...)` and `get_initial_cache_state(...)`.
2. **Per-chunk step** — the `conformer_stream_step(...)` argument names and the
   tuple it returns (cache tensors, hypotheses, transcribed texts).
3. **Chunk size** — must match the checkpoint's `att_context_size` / streaming
   config; the `chunk_samples` derivation is a best-effort default.

Quick smoke test once running:

```sh
# stream a 16kHz mono WAV through the socket and print partial/final JSON
python - <<'PY'
import asyncio, json, wave, websockets
async def go():
    w = wave.open("sample_16k_mono.wav","rb"); pcm = w.readframes(w.getnframes())
    async with websockets.connect("ws://127.0.0.1:8088") as ws:
        for i in range(0, len(pcm), 3200):           # ~100ms frames
            await ws.send(pcm[i:i+3200])
        await ws.send(json.dumps({"type":"eof"}))
        async for m in ws: print(m)
asyncio.run(go())
PY
```

You should see a stream of `{"type":"partial",...}` then one `{"type":"final",...}`.

## Scope
- **English only** (by design — Cantonese stays on batch SenseVoice; route by
  language if you need both).
- Pairs with `STT_LOOKAHEAD` for the latency/accuracy trade. Start at `1`.
- This is the model-swap path. Steps 1–3 of the realtime upgrade (LLM SSE, TTS
  StreamAdapter, turn detector) need none of this and ship independently.
