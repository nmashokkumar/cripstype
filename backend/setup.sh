#!/usr/bin/env bash
# ==============================================================================
# CrispType — One-Command Self-Hosted Server Setup (Ubuntu / Debian / Cloud VM)
#
# Usage:
#   bash setup.sh
#
# Optional environment flags:
#   CRISPTYPE_ASR_ENGINE=parakeet        -> Installs onnx-asr for NVIDIA Parakeet TDT
#   CRISPTYPE_ASR_ENGINE=faster_whisper  -> Default fast CPU/GPU Faster-Whisper (int8/fp16)
#   CRISPTYPE_ASR_ENGINE=seamless_m4t_v2 -> Installs PyTorch + Transformers for SeamlessM4T v2
#   PORT=8000                            -> Listening port (default: 8000)
#
# What this script does automatically:
#   1. Installs required OS packages (ffmpeg, cmake, g++, python3-venv) if missing
#   2. Downloads ONNX Runtime C++ SDK & compiles native C++17 Silero VAD v5
#   3. Downloads the Silero VAD v5 ONNX model
#   4. Creates a clean Python virtualenv & installs backend dependencies
#   5. Generates a cryptographically random CRISPTYPE_API_KEY in .env (if missing)
#   6. Starts FastAPI + WebSocket server and prints your Server URL + API Key
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ORT_VERSION="1.19.2"
PORT="${PORT:-8000}"

echo ""
echo "=========================================================="
echo "  CrispType Dictation Server — One-Command Setup"
echo "=========================================================="
echo ""

# 1. System packages (uses sudo if available and not root)
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

if command -v apt-get >/dev/null 2>&1; then
  echo "[1/5] Ensuring system build tools and ffmpeg are installed..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq build-essential cmake curl ffmpeg libsndfile1 python3 python3-venv python3-pip >/dev/null
fi

# 2. Download ONNX Runtime C++ SDK & compile native C++17 Silero VAD
echo "[2/5] Preparing native C++17 Silero VAD v5..."
ARCH="$(uname -m)"
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  ORT_ARCH="aarch64"
else
  ORT_ARCH="x64"
fi

ORT_DIR="$SCRIPT_DIR/.onnxruntime"
if [ ! -f "$ORT_DIR/include/onnxruntime_cxx_api.h" ]; then
  mkdir -p "$ORT_DIR"
  curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-${ORT_ARCH}-${ORT_VERSION}.tgz" \
    -o /tmp/crisptype-ort.tgz
  tar -xzf /tmp/crisptype-ort.tgz -C "$ORT_DIR" --strip-components=1
  rm -f /tmp/crisptype-ort.tgz
fi

if command -v cmake >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1; then
  cmake -S "$SCRIPT_DIR/native" -B "$SCRIPT_DIR/native/build" -DONNXRUNTIME_ROOT="$ORT_DIR" >/dev/null
  cmake --build "$SCRIPT_DIR/native/build" --config Release -j"$(nproc 2>/dev/null || echo 2)" >/dev/null
  echo "      Built native C++ library: native/build/libsilero_vad.so"
else
  echo "      Warning: cmake/g++ not found; server will fall back to Python ONNX Silero VAD."
fi

# 3. Download Silero VAD v5 ONNX weights
echo "[3/5] Downloading Silero VAD v5 model..."
mkdir -p "$SCRIPT_DIR/models"
if [ ! -f "$SCRIPT_DIR/models/silero_vad.onnx" ]; then
  curl -fsSL "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx" \
    -o "$SCRIPT_DIR/models/silero_vad.onnx"
fi

# 4. Python virtual environment & dependencies
echo "[4/5] Installing Python ASR & FastAPI dependencies..."
if [ ! -d "$SCRIPT_DIR/.venv" ]; then
  python3 -m venv "$SCRIPT_DIR/.venv"
fi
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.venv/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet -r "$SCRIPT_DIR/requirements.txt"

ASR_CHOICE="${CRISPTYPE_ASR_ENGINE:-${FLOW_ASR_ENGINE:-faster_whisper}}"
if [ "$ASR_CHOICE" = "parakeet" ]; then
  echo "      Installing onnx-asr for NVIDIA Parakeet TDT..."
  pip install --quiet onnx-asr
elif [ "$ASR_CHOICE" = "seamless_m4t_v2" ]; then
  echo "      Installing PyTorch + Transformers for SeamlessM4T v2..."
  pip install --quiet torch transformers sentencepiece
fi

# 5. Generate .env with a secure random API key if missing
echo "[5/5] Finalizing server configuration..."
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  GENERATED_KEY="$(python3 -c 'import secrets; print("ct_" + secrets.token_urlsafe(32))')"
  sed -i.bak "s|^CRISPTYPE_API_KEY=.*|CRISPTYPE_API_KEY=${GENERATED_KEY}|" "$SCRIPT_DIR/.env" && rm -f "$SCRIPT_DIR/.env.bak"
  chmod 600 "$SCRIPT_DIR/.env"
fi

# Export .env for the running server
set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

export LD_LIBRARY_PATH="$ORT_DIR/lib:${LD_LIBRARY_PATH:-}"
export SILERO_VAD_LIB_PATH="$SCRIPT_DIR/native/build/libsilero_vad.so"
export SILERO_VAD_MODEL_PATH="$SCRIPT_DIR/models/silero_vad.onnx"

PUBLIC_HOST="${CRISPTYPE_PUBLIC_URL:-${INSTABOX_PUBLIC_URL:-http://localhost:${PORT}}}"
ACTIVE_KEY="${CRISPTYPE_API_KEY:-${FLOW_API_KEY:-}}"

echo ""
echo "=========================================================="
echo "  CrispType Server is ready on port ${PORT}!"
echo "----------------------------------------------------------"
echo "  Open CrispType -> Settings -> Server and paste:"
echo "    Server URL : ${PUBLIC_HOST}"
if [ -n "${ACTIVE_KEY}" ]; then
  echo "    API Key    : ${ACTIVE_KEY}"
else
  echo "    API Key    : (none configured)"
fi
echo "=========================================================="
echo ""

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
