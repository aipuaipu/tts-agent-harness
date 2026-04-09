# whisperx-svc — CPU build
# Multi-stage: stage 1 installs Python deps into a venv; stage 2 is a slim
# runtime with ffmpeg + the venv + service code.

ARG PYTHON_VERSION=3.12
ARG WHISPERX_DEVICE=cpu

# ---------------------------------------------------------------------------
# Stage 1: builder
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Build deps for a few Python wheels (e.g. av, ctranslate2 on ARM).
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --upgrade pip

# CPU-only torch wheels are materially smaller than the default CUDA ones.
# whisperx depends on torch; we pre-install it from the CPU index first so
# the whisperx install reuses that wheel instead of pulling the CUDA build.
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        "torch>=2.1,<2.4" \
        "torchaudio>=2.1,<2.4"

RUN pip install \
        "fastapi>=0.115,<0.116" \
        "uvicorn[standard]>=0.30,<0.32" \
        "python-multipart>=0.0.9" \
        "pydantic>=2.7,<3" \
        "whisperx>=3.1.5"

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    TORCH_HOME=/models \
    HF_HOME=/models \
    XDG_CACHE_HOME=/models \
    MODEL_CACHE_DIR=/models \
    WHISPER_MODEL=large-v3 \
    WHISPER_DEVICE=cpu

# Runtime deps: ffmpeg for audio I/O, curl for the container healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY server.py /app/server.py

RUN mkdir -p /models
VOLUME ["/models"]

EXPOSE 7860

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=30 \
    CMD curl -fsS http://localhost:7860/readyz || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860"]
