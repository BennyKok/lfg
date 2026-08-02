"""
lfg streaming STT server — NeMo cache-aware FastConformer over a websocket.

This is the server half of the high-performance realtime voice path. It accepts
a raw 16 kHz mono int16 PCM audio stream and emits interim ("partial") and
"final" transcripts as the user speaks, so the caller can endpoint a turn
and react far sooner than batch whisper allows.

Wire protocol:
  client -> server : binary ws frames of raw 16 kHz mono int16 PCM
                     then a text frame {"type":"eof"} when the utterance ends.
  server -> client : text frames {"type":"partial","text":"..."} as it decodes
                     and one {"type":"final","text":"..."} at end of stream.

Model: a NeMo *cache-aware streaming* FastConformer checkpoint, e.g.
  stt_en_fastconformer_hybrid_large_streaming_multi
(English; multi-lookahead cache-aware streaming). This is the same FastConformer
family as the batch Parakeet you already run, so it stays on the existing NeMo
GPU box — only the checkpoint + the per-chunk inference loop change.

⚠️  VERIFY BEFORE PROD: the cache-aware streaming inference API (cache tensor
    setup + per-chunk step) varies across NeMo releases. The calls below follow
    the documented `conformer_stream_step` pattern, but confirm them against the
    NeMo version + checkpoint you deploy (see README.md → "Validate on the box").
    Chunk size / lookahead must match the checkpoint's att_context_size.

Run:  STT_MODEL=stt_en_fastconformer_hybrid_large_streaming_multi \
      STT_WS_HOST=0.0.0.0 STT_WS_PORT=8088 \
      python server.py
Then point the agent at it:  STT_WS_URL=ws://<host>:8088
"""

from __future__ import annotations

import asyncio
import json
import os

import numpy as np
import torch
import websockets

MODEL_NAME = os.environ.get("STT_MODEL", "stt_en_fastconformer_hybrid_large_streaming_multi")
HOST = os.environ.get("STT_WS_HOST", "0.0.0.0")
PORT = int(os.environ.get("STT_WS_PORT", "8088"))
DEVICE = os.environ.get("STT_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
SAMPLE_RATE = 16000

# Lookahead profile for multi-lookahead checkpoints. Lower index = lower latency,
# slightly lower accuracy. Tune per checkpoint (see its att_context_size list).
ATT_LOOKAHEAD = int(os.environ.get("STT_LOOKAHEAD", "1"))


def load_model():
    import nemo.collections.asr as nemo_asr

    print(f"[stt] loading {MODEL_NAME} on {DEVICE} ...", flush=True)
    model = nemo_asr.models.ASRModel.from_pretrained(MODEL_NAME)
    model = model.to(DEVICE).eval()

    # Put the encoder into cache-aware streaming mode and pick the lookahead.
    # ⚠️ VERIFY: method names below are the documented streaming API; confirm for
    # your NeMo version. Some releases use setup_streaming_params(att_context_size=...).
    try:
        model.encoder.set_default_att_context_size(
            model.encoder.att_context_size_all[ATT_LOOKAHEAD]
        )
    except Exception as e:  # pragma: no cover - checkpoint-dependent
        print(f"[stt] could not set att_context_size ({e}); using default", flush=True)
    model.encoder.setup_streaming_params()
    # Per-chunk audio samples the encoder expects for one streaming step.
    # Derived from the model's streaming config; VERIFY against the checkpoint.
    chunk_samples = int(getattr(model.encoder, "streaming_cfg", None).chunk_size[0]
                        * model.cfg.preprocessor.window_stride * SAMPLE_RATE) \
        if hasattr(model.encoder, "streaming_cfg") else int(0.16 * SAMPLE_RATE)
    print(f"[stt] ready; chunk={chunk_samples} samples (~{chunk_samples/SAMPLE_RATE*1000:.0f}ms)", flush=True)
    return model, chunk_samples


class StreamSession:
    """Per-connection streaming decode state (cache tensors + running hypothesis)."""

    def __init__(self, model, chunk_samples: int) -> None:
        self.model = model
        self.chunk_samples = chunk_samples
        self.buf = np.zeros(0, dtype=np.float32)
        self.text = ""
        # Cache-aware streaming state — initialized lazily on first step.
        self.cache_last_channel = None
        self.cache_last_time = None
        self.cache_last_channel_len = None
        self.previous_hypotheses = None
        self.pred_out_stream = None

    def _init_cache(self) -> None:
        ch, t, cl = self.model.encoder.get_initial_cache_state(batch_size=1)
        self.cache_last_channel = ch.to(DEVICE)
        self.cache_last_time = t.to(DEVICE)
        self.cache_last_channel_len = cl.to(DEVICE)

    @torch.no_grad()
    def _step(self, samples: np.ndarray) -> str:
        """Run one cache-aware streaming step over `samples`; return cumulative text.

        ⚠️ VERIFY: `conformer_stream_step` arg/return shape is checkpoint- and
        version-dependent. This mirrors NeMo's cache-aware streaming example
        (examples/asr/asr_cache_aware_streaming/). Adjust the call to match the
        signature reported by your NeMo build if it differs.
        """
        if self.cache_last_channel is None:
            self._init_cache()
        audio = torch.tensor(samples, dtype=torch.float32, device=DEVICE).unsqueeze(0)
        audio_len = torch.tensor([audio.shape[1]], dtype=torch.long, device=DEVICE)
        (
            self.pred_out_stream,
            transcribed_texts,
            self.cache_last_channel,
            self.cache_last_time,
            self.cache_last_channel_len,
            self.previous_hypotheses,
        ) = self.model.conformer_stream_step(
            processed_signal=None,
            processed_signal_length=None,
            audio_signal=audio,
            audio_signal_length=audio_len,
            cache_last_channel=self.cache_last_channel,
            cache_last_time=self.cache_last_time,
            cache_last_channel_len=self.cache_last_channel_len,
            keep_all_outputs=False,
            previous_hypotheses=self.previous_hypotheses,
            previous_pred_out=self.pred_out_stream,
            drop_extra_pre_encoded=None,
            return_transcription=True,
        )
        if transcribed_texts:
            t = transcribed_texts[0]
            self.text = t.text if hasattr(t, "text") else str(t)
        return self.text

    def feed(self, pcm: bytes) -> list[str]:
        """Add PCM bytes; return a partial transcript for each completed chunk."""
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        self.buf = np.concatenate([self.buf, samples])
        partials: list[str] = []
        while len(self.buf) >= self.chunk_samples:
            chunk = self.buf[: self.chunk_samples]
            self.buf = self.buf[self.chunk_samples :]
            partials.append(self._step(chunk))
        return partials

    def flush(self) -> str:
        """Run the trailing (<1 chunk) audio and return the final transcript."""
        if len(self.buf) > 0:
            pad = np.zeros(self.chunk_samples - len(self.buf), dtype=np.float32)
            self._step(np.concatenate([self.buf, pad]))
            self.buf = np.zeros(0, dtype=np.float32)
        return self.text


async def handler(ws, model, chunk_samples) -> None:
    # One connection is long-lived across many utterances. "flush" finalizes the
    # current utterance and resets streaming state for the next; "eof" finalizes
    # and closes. (LfgSpeechStream sends "flush" on each VAD/turn boundary.)
    sess = StreamSession(model, chunk_samples)
    loop = asyncio.get_running_loop()
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                # Inference is blocking/CPU+GPU-bound — run off the event loop.
                partials = await loop.run_in_executor(None, sess.feed, msg)
                if partials:
                    await ws.send(json.dumps({"type": "partial", "text": partials[-1]}))
            else:
                try:
                    ev = json.loads(msg)
                except Exception:
                    continue
                kind = ev.get("type")
                if kind in ("flush", "eof"):
                    final = await loop.run_in_executor(None, sess.flush)
                    await ws.send(json.dumps({"type": "final", "text": final}))
                    if kind == "eof":
                        return
                    sess = StreamSession(model, chunk_samples)  # reset for next turn
    except websockets.ConnectionClosed:
        pass


async def main() -> None:
    model, chunk_samples = load_model()

    async def _h(ws):
        await handler(ws, model, chunk_samples)

    print(f"[stt] websocket listening on ws://{HOST}:{PORT}", flush=True)
    async with websockets.serve(_h, HOST, PORT, max_size=None):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
