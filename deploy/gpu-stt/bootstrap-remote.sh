#!/usr/bin/env bash
# Idempotent: ensure the SenseVoice STT service is installed AND running.
# Runs ON the GPU box. Safe to re-run on every box start (persistence hook).
set -euo pipefail
export PATH=/opt/conda/bin:$PATH
export DEBIAN_FRONTEND=noninteractive
APP=/opt/stt
mkdir -p "$APP"

# deps (only if missing)
python -c "import funasr, soundfile, scipy, fastapi, uvicorn, opencc, huggingface_hub" 2>/dev/null \
  || pip install -q --no-input funasr soundfile scipy "numpy<2" librosa huggingface_hub fastapi "uvicorn[standard]" opencc
command -v tmux >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq tmux >/dev/null 2>&1; }

# launcher (in case it's missing after a fresh rootfs)
if [ ! -f "$APP/run.sh" ]; then
  cat > "$APP/run.sh" <<'SH'
#!/usr/bin/env bash
set -a; [ -f /opt/stt/stt.env ] && . /opt/stt/stt.env; set +a
export PATH=/opt/conda/bin:$PATH
exec python /opt/stt/server.py
SH
  chmod +x "$APP/run.sh"
fi

healthy() {
  python - <<'PY' 2>/dev/null
import urllib.request, sys
try:
    urllib.request.urlopen("http://127.0.0.1:8087/health", timeout=3); sys.exit(0)
except Exception:
    sys.exit(1)
PY
}

if healthy; then
  echo "[bootstrap] STT already healthy"
fi

if ! healthy; then
  echo "[bootstrap] starting STT service..."
  tmux kill-session -t stt 2>/dev/null || true
  tmux new-session -d -s stt "bash $APP/run.sh > $APP/server.log 2>&1"
  for i in $(seq 1 30); do healthy && break; sleep 2; done
  healthy && echo "[bootstrap] STT up on :8087" || { echo "[bootstrap] STT FAILED"; tail -n 20 "$APP/server.log" 2>/dev/null; }
fi

# Parakeet STT (English / multilingual-v3) — optional STT engine on its own port
# (default :8091; :8087 is taken by the STT engine). Opt-in via
# PARAKEET_ENABLE=1 in stt.env so the heavy NeMo deps only land when wanted.
# Point lfg's STT_UPSTREAM at :$PARAKEET_PORT to make it the orb default.
PPORT="${PARAKEET_PORT:-8091}"
parakeet_healthy() {
  python - "$PPORT" <<'PY' 2>/dev/null
import urllib.request, sys
try:
    urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/health", timeout=3); sys.exit(0)
except Exception:
    sys.exit(1)
PY
}
if [ "${PARAKEET_ENABLE:-0}" = "1" ] && [ -f "$APP/parakeet_stt.py" ]; then
  python -c "import nemo.collections.asr" 2>/dev/null \
    || pip install -q --no-input "nemo_toolkit[asr]" soundfile scipy "numpy<2" fastapi "uvicorn[standard]"
  if [ ! -f "$APP/run-parakeet.sh" ]; then
    cat > "$APP/run-parakeet.sh" <<'SH'
#!/usr/bin/env bash
set -a; [ -f /opt/stt/stt.env ] && . /opt/stt/stt.env; set +a
export PATH=/opt/conda/bin:$PATH
exec python /opt/stt/parakeet_stt.py
SH
    chmod +x "$APP/run-parakeet.sh"
  fi
  if ! parakeet_healthy; then
    echo "[bootstrap] starting Parakeet STT service..."
    tmux kill-session -t parakeet 2>/dev/null || true
    tmux new-session -d -s parakeet "bash $APP/run-parakeet.sh > $APP/parakeet.log 2>&1"
    for i in $(seq 1 45); do parakeet_healthy && break; sleep 2; done
    parakeet_healthy && echo "[bootstrap] Parakeet up on :$PPORT" || echo "[bootstrap] Parakeet not healthy yet (lazy model load)"
  else
    echo "[bootstrap] Parakeet already healthy"
  fi
fi
echo "[bootstrap] done"
