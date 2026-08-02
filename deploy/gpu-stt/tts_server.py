#!/usr/bin/env python3
"""Cantonese TTS for lfg — CosyVoice2-0.5B on the Novita 5090.

Honors the contract lfg-serve's /api/voice/tts proxy speaks:

    POST /tts
      Content-Type: application/json   { "text": "...", "voice": "F1" }
      Authorization: Bearer $TTS_TOKEN
    -> 200 audio/wav
    GET /health -> { ok, tts, lang }

Zero-shot Cantonese: we prime CosyVoice2 with a short Cantonese reference clip
(reused from the SenseVoice example) + its transcript, so output speaks Cantonese
in that reference voice. Runs as its own process/port (8088), isolated from the
SenseVoice STT service so a TTS issue can't take STT down.

Env:
  TTS_TOKEN          required; shared secret (same as STT_TOKEN is fine)
  COSY_MODEL         default /opt/CosyVoice/pretrained_models/CosyVoice2-0.5B
  COSY_PROMPT_WAV    default /opt/stt/yue_prompt.wav  (16 kHz Cantonese reference)
  COSY_PROMPT_TEXT   transcript of the reference clip
  TTS_HOST / TTS_PORT  default 0.0.0.0 / 8088
"""
import io
import os
import sys
import wave

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

sys.path.append("/opt/CosyVoice")
sys.path.append("/opt/CosyVoice/third_party/Matcha-TTS")

TOKEN = os.environ.get("TTS_TOKEN")
MODEL_DIR = os.environ.get("COSY_MODEL", "/opt/CosyVoice/pretrained_models/CosyVoice2-0.5B")
PROMPT_WAV = os.environ.get("COSY_PROMPT_WAV", "/opt/stt/yue_prompt.wav")
PROMPT_TEXT = os.environ.get("COSY_PROMPT_TEXT", "呢幾個字都表達唔到我想講嘅意思。")

if not TOKEN:
    raise SystemExit("TTS_TOKEN is required")

app = FastAPI()
_model = None


SPK_ID = "yue_spk"


def model():
    global _model
    if _model is None:
        from cosyvoice.cli.cosyvoice import CosyVoice2

        _model = CosyVoice2(MODEL_DIR, load_jit=False, load_trt=False, fp16=True)
        # Register the fixed Cantonese voice ONCE so each request skips the
        # per-call prompt processing (CPU onnx speaker-embed + prompt tokens) —
        # that fixed cost was dominating short replies.
        _model.add_zero_shot_spk(PROMPT_TEXT, PROMPT_WAV, SPK_ID)
    return _model


class Req(BaseModel):
    text: str
    voice: str | None = None


def _pcm_wav(samples: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(pcm)
    w.close()
    return buf.getvalue()


@app.on_event("startup")
def _warmup():
    # Pre-load CosyVoice2 + register the voice in the background so the FIRST
    # real request isn't a ~18s cold load. /health stays responsive meanwhile.
    import threading

    threading.Thread(target=model, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True, "tts": "CosyVoice2", "lang": "yue", "warm": _model is not None}


def _f32_to_pcm16(a: np.ndarray) -> bytes:
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


@app.post("/tts")
def tts(
    req: Req,
    authorization: str = Header(default=""),
    format: str = Query("pcm"),
):
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    m = model()
    # This CosyVoice build's inference_zero_shot takes the prompt as a FILE PATH.
    if format == "wav":
        # buffered WAV — for inspection / non-streaming callers
        chunks = [
            out["tts_speech"].squeeze(0).cpu().numpy()
            for out in m.inference_zero_shot(text, "", "", zero_shot_spk_id=SPK_ID, stream=False)
        ]
        audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype="float32")
        return Response(content=_pcm_wav(audio, m.sample_rate), media_type="audio/wav")

    # default: STREAM raw int16 PCM as CosyVoice2 produces each chunk (~150ms
    # first-chunk). Callers stream these to the client progressively.
    def gen():
        for out in m.inference_zero_shot(text, "", "", zero_shot_spk_id=SPK_ID, stream=True):
            yield _f32_to_pcm16(out["tts_speech"].squeeze(0).cpu().numpy())

    return StreamingResponse(
        gen(),
        media_type="audio/pcm",
        headers={"X-Sample-Rate": str(m.sample_rate)},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("TTS_HOST", "0.0.0.0"),
        port=int(os.environ.get("TTS_PORT", "8088")),
    )
