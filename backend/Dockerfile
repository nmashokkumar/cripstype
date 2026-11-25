FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ONNXRUNTIME_VERSION=1.19.2 \
    PORT=8000

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      curl \
      ffmpeg \
      libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Install ONNX Runtime C++ SDK and build native C++17 Silero VAD shared library
RUN ARCH="$(uname -m)" && \
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then ORT_ARCH="aarch64"; else ORT_ARCH="x64"; fi && \
    curl -fsSL "https://github.com/microsoft/onnxruntime/releases/download/v${ONNXRUNTIME_VERSION}/onnxruntime-linux-${ORT_ARCH}-${ONNXRUNTIME_VERSION}.tgz" \
      -o /tmp/ort.tgz && \
    mkdir -p /opt/onnxruntime && \
    tar -xzf /tmp/ort.tgz -C /opt/onnxruntime --strip-components=1 && \
    rm -f /tmp/ort.tgz

COPY native /app/native
RUN cmake -S /app/native -B /app/native/build -DONNXRUNTIME_ROOT=/opt/onnxruntime && \
    cmake --build /app/native/build --config Release -j"$(nproc)"

# 2. Download Silero VAD v5 ONNX model
RUN mkdir -p /app/models && \
    curl -fsSL "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx" \
      -o /app/models/silero_vad.onnx

# 3. Install Python dependencies and copy application code
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

ENV LD_LIBRARY_PATH="/opt/onnxruntime/lib:${LD_LIBRARY_PATH}" \
    SILERO_VAD_LIB_PATH="/app/native/build/libsilero_vad.so" \
    SILERO_VAD_MODEL_PATH="/app/models/silero_vad.onnx"

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
