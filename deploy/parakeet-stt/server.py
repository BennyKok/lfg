#!/usr/bin/env python3
"""NVIDIA Parakeet STT host for lfg.

Honors the same contract lfg-serve's /api/voice/stt proxy already speaks to:

    POST /stt
      Content-Type: application/octet-stream   (a WAV file; any rate/channels)
      Authorization: Bearer $STT_TOKEN
    -> 200 { "text": "..." }

The lfg browser captures mic audio at the native AudioContext rate (44.1/48 kHz)
and encodes 16-bit mono WAV. Parakeet wants 16 kHz mono, so we resample here —
the frontend and the lfg proxy stay unchanged.

Env:
  STT_TOKEN     required; shared secret, must match the client's STT_TOKEN
  STT_MODEL     default nvidia/parakeet-tdt-0.6b-v2 (English).
                Use nvidia/parakeet-tdt-0.6b-v3 for multilingual (~25 langs).
  STT_DEVICE    cuda (default) | cpu
  STT_HOST      bind host, default 0.0.0.0
  STT_PORT      bind port, default 8087
"""
import io
import os
import tempfile

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, Header, HTTPException, Request
from scipy.signal import resample_poly

MODEL_NAME = os.environ.get("STT_MODEL", "nvidia/parakeet-tdt-0.6b-v2")
DEVICE = os.environ.get("STT_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
TOKEN = os.environ.get("STT_TOKEN")
TARGET_SR = 16000

if not TOKEN:
    raise SystemExit("STT_TOKEN is required")

app = FastAPI()
_model = None


def model():
    """Lazy-load so the process boots fast and `import` stays cheap."""
    global _model
    if _model is None:
        import nemo.collections.asr as nemo_asr

        m = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
        m = m.to(DEVICE).eval()
        _model = m
    return _model


def to_16k_mono(raw: bytes) -> np.ndarray:
    """WAV bytes (any rate / channel count) -> float32 mono @ 16 kHz."""
    data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)  # downmix
    if sr != TARGET_SR:
        # polyphase resample by the reduced sr/16000 ratio
        from math import gcd

        g = gcd(int(sr), TARGET_SR)
        mono = resample_poly(mono, TARGET_SR // g, int(sr) // g).astype(np.float32)
    return mono


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "device": DEVICE}


@app.post("/stt")
async def stt(request: Request, authorization: str = Header(default="")):
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio")
    try:
        audio = to_16k_mono(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad audio: {e}")
    if audio.size == 0:
        return {"text": ""}

    # NeMo transcribes from file paths most reliably across versions; write the
    # resampled mono clip to a temp wav and hand it over.
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sf.write(f.name, audio, TARGET_SR, subtype="PCM_16")
        with torch.inference_mode():
            out = model().transcribe([f.name], batch_size=1)
    # NeMo returns either [str] or [Hypothesis] depending on version.
    first = out[0] if out else ""
    text = getattr(first, "text", first)
    return {"text": (text or "").strip()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("STT_HOST", "0.0.0.0"),
        port=int(os.environ.get("STT_PORT", "8087")),
    )
