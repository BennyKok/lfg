# Parakeet STT host

Self-hosted [NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)
transcription service that drops in behind OMG's existing `/api/voice/stt` proxy
— same wire contract the previous faster-whisper host used, so **no frontend or
lfg-serve code changes are needed** beyond pointing `STT_UPSTREAM` at this box.

## Contract

```
POST /stt
  Content-Type: application/octet-stream   # a WAV file, any rate/channels
  Authorization: Bearer $STT_TOKEN
-> { "text": "..." }

GET /health -> { ok, model, device }
```

The browser sends 16-bit mono WAV at the native AudioContext rate (44.1/48 kHz);
this service resamples to 16 kHz mono internally before inference.

## Requirements

- An NVIDIA GPU (recommended) with recent drivers, or CPU (0.6B runs on CPU,
  just slower). This is the one hard prerequisite — the previous host ran
  faster-whisper; Parakeet wants a GPU to earn its ~10× speedup.
- Python 3.10+.

## Install (GPU box)

```bash
sudo mkdir -p /opt/parakeet-stt && sudo chown "$USER" /opt/parakeet-stt
cp server.py requirements.txt /opt/parakeet-stt/
cd /opt/parakeet-stt
python -m venv venv && . venv/bin/activate
# Install torch matched to your CUDA first, e.g. cu121:
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
```

Create `/opt/parakeet-stt/parakeet-stt.env`:

```
STT_TOKEN=<same secret as OMG's STT_TOKEN>
STT_MODEL=nvidia/parakeet-tdt-0.6b-v2   # or -v3 for multilingual
STT_DEVICE=cuda
STT_PORT=8087
```

Install the unit:

```bash
sudo cp parakeet-stt.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now parakeet-stt
curl -s localhost:8087/health   # { ok: true, ... } once the model has loaded
```

## Wire OMG to it

On the OMG box, in `.env`:

```
STT_UPSTREAM=http://<parakeet-box>:8087
STT_TOKEN=<same secret>
```

Then `systemctl --user restart lfg-serve.service`.

## Smoke test

```bash
curl -sS -X POST http://<parakeet-box>:8087/stt \
  -H "Authorization: Bearer $STT_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @sample.wav
# {"text":"..."}
```

## Notes

- `-v2` is English-only; `-v3` covers ~25 languages with auto language ID.
- First boot downloads the model from Hugging Face (~2.4 GB); subsequent starts
  are fast.
- **Not currently wired into OMG.** `serve` routes `/api/voice/stt` through
  `src/voice-providers.ts`, which only has ElevenLabs and OpenAI adapters — it
  does not read `STT_UPSTREAM`. Using this box means adding a self-hosted
  adapter there first.
