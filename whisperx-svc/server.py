"""WhisperX HTTP service — P3 transcribe pipeline stage.

Single-file FastAPI app that keeps the WhisperX model resident in memory.
Audio is received via multipart upload; transcript is returned inline.

Contract (ADR-002 §3.2):
    POST /transcribe (multipart: audio, language, return_word_timestamps)
    GET  /healthz    → {"model_loaded": bool, "device": str, "model": str}
    GET  /readyz     → 200 if loaded else 503

Design notes:
- Model load happens in FastAPI lifespan. Health endpoints stay responsive
  during cold start and report model_loaded=false until load completes.
- Model lives on a module-level singleton (`STATE`). One process = one load.
- We persist model cache to /models (see Dockerfile envs TORCH_HOME, HF_HOME).
- No DB, no object storage, no business logic (strict W0 scope).
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("whisperx-svc")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
# float16 only works on CUDA; cpu must use int8 or float32.
WHISPER_COMPUTE_TYPE = os.environ.get(
    "WHISPER_COMPUTE_TYPE",
    "int8" if WHISPER_DEVICE == "cpu" else "float16",
)
MODEL_CACHE_DIR = os.environ.get("MODEL_CACHE_DIR", "/models")

# Test hook: when set, /transcribe will return an empty transcript without
# actually invoking whisperx. Used by the smoke test so CI does not need the
# multi-GB model weights.
WHISPERX_STUB_MODE = os.environ.get("WHISPERX_STUB_MODE", "0") == "1"


# ---------------------------------------------------------------------------
# In-process state
# ---------------------------------------------------------------------------


@dataclass
class ServiceState:
    model_loaded: bool = False
    load_error: str | None = None
    model: Any = None
    align_models: dict[str, tuple[Any, Any]] = field(default_factory=dict)
    device: str = WHISPER_DEVICE
    model_name: str = WHISPER_MODEL


STATE = ServiceState()


def _load_model_blocking() -> None:
    """Load WhisperX model. Called from a worker thread during lifespan."""
    if WHISPERX_STUB_MODE:
        logger.warning("WHISPERX_STUB_MODE=1 — skipping real model load")
        STATE.model_loaded = True
        return

    try:
        import whisperx  # noqa: WPS433 — deferred import to keep import cost out of cold start

        Path(MODEL_CACHE_DIR).mkdir(parents=True, exist_ok=True)
        logger.info(
            "loading whisperx model=%s device=%s compute_type=%s cache=%s",
            WHISPER_MODEL,
            WHISPER_DEVICE,
            WHISPER_COMPUTE_TYPE,
            MODEL_CACHE_DIR,
        )
        t0 = time.time()
        STATE.model = whisperx.load_model(
            WHISPER_MODEL,
            WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
            download_root=MODEL_CACHE_DIR,
        )
        STATE.model_loaded = True
        logger.info("model loaded in %.1fs", time.time() - t0)
    except Exception as exc:  # noqa: BLE001 — we want to record any error
        STATE.load_error = f"{type(exc).__name__}: {exc}"
        logger.exception("model load failed")


def _get_align_model(language: str):
    """Lazily load and cache the wav2vec2 alignment model per language."""
    if language in STATE.align_models:
        return STATE.align_models[language]
    import whisperx  # noqa: WPS433

    logger.info("loading align model language=%s", language)
    align_model, metadata = whisperx.load_align_model(
        language_code=language,
        device=WHISPER_DEVICE,
        model_dir=MODEL_CACHE_DIR,
    )
    STATE.align_models[language] = (align_model, metadata)
    return STATE.align_models[language]


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    # Load in a background task so /healthz is reachable while loading.
    loop = asyncio.get_running_loop()
    load_task = loop.run_in_executor(None, _load_model_blocking)
    try:
        yield
    finally:
        # Best-effort: wait briefly so a clean shutdown doesn't leak the thread.
        if not load_task.done():
            load_task.cancel()


app = FastAPI(
    title="whisperx-svc",
    version="0.1.0",
    description="P3 transcription service for TTS Agent Harness (ADR-001 §4.8).",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class Word(BaseModel):
    word: str
    start: float
    end: float
    score: float | None = None


class TranscribeResponse(BaseModel):
    transcript: list[Word]
    language: str
    duration_s: float
    model: str


class HealthResponse(BaseModel):
    model_loaded: bool
    device: str
    model: str
    error: str | None = None


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(
        model_loaded=STATE.model_loaded,
        device=STATE.device,
        model=STATE.model_name,
        error=STATE.load_error,
    )


@app.get("/readyz")
async def readyz() -> JSONResponse:
    if STATE.model_loaded:
        return JSONResponse({"status": "ready"}, status_code=200)
    payload: dict[str, Any] = {"status": "loading"}
    if STATE.load_error:
        payload["error"] = STATE.load_error
    return JSONResponse(payload, status_code=503)


@app.post(
    "/transcribe",
    response_model=TranscribeResponse,
    responses={503: {"model": ErrorResponse}, 400: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
)
async def transcribe(
    audio: UploadFile = File(...),
    language: Literal["zh", "en"] = Form("zh"),
    return_word_timestamps: bool = Form(True),
) -> TranscribeResponse | JSONResponse:
    if not STATE.model_loaded:
        return JSONResponse(
            ErrorResponse(
                error="model_not_loaded",
                detail=STATE.load_error or "model is still loading",
            ).model_dump(),
            status_code=503,
        )

    if audio.filename is None:
        return JSONResponse(
            ErrorResponse(error="bad_request", detail="audio filename missing").model_dump(),
            status_code=400,
        )

    suffix = Path(audio.filename).suffix or ".wav"
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            ErrorResponse(error="io_error", detail=str(exc)).model_dump(),
            status_code=500,
        )

    try:
        return await asyncio.get_running_loop().run_in_executor(
            None,
            _run_transcribe_blocking,
            tmp_path,
            language,
            return_word_timestamps,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("transcribe failed")
        return JSONResponse(
            ErrorResponse(error="transcribe_failed", detail=f"{type(exc).__name__}: {exc}").model_dump(),
            status_code=500,
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _run_transcribe_blocking(
    audio_path: str,
    language: str,
    return_word_timestamps: bool,
) -> TranscribeResponse:
    """Run the actual whisperx pipeline. Executed in a worker thread."""
    # Stub branch — for smoke tests without model weights.
    if WHISPERX_STUB_MODE:
        duration = _probe_duration(audio_path)
        return TranscribeResponse(
            transcript=[],
            language=language,
            duration_s=duration,
            model=f"{WHISPER_MODEL} (stub)",
        )

    import whisperx  # noqa: WPS433

    audio = whisperx.load_audio(audio_path)
    duration_s = float(len(audio)) / 16000.0

    result = STATE.model.transcribe(audio, language=language, batch_size=8)
    detected_language = result.get("language", language)

    words: list[Word] = []
    if return_word_timestamps and result.get("segments"):
        try:
            align_model, metadata = _get_align_model(detected_language)
            aligned = whisperx.align(
                result["segments"],
                align_model,
                metadata,
                audio,
                WHISPER_DEVICE,
                return_char_alignments=False,
            )
            for seg in aligned.get("segments", []):
                for w in seg.get("words", []) or []:
                    if "start" not in w or "end" not in w:
                        continue
                    words.append(
                        Word(
                            word=str(w.get("word", "")).strip(),
                            start=float(w["start"]),
                            end=float(w["end"]),
                            score=float(w["score"]) if w.get("score") is not None else None,
                        )
                    )
        except Exception:  # noqa: BLE001
            logger.exception("alignment failed; returning segment-level transcript")
            for seg in result.get("segments", []):
                words.append(
                    Word(
                        word=str(seg.get("text", "")).strip(),
                        start=float(seg.get("start", 0.0)),
                        end=float(seg.get("end", 0.0)),
                        score=None,
                    )
                )
    else:
        for seg in result.get("segments", []):
            words.append(
                Word(
                    word=str(seg.get("text", "")).strip(),
                    start=float(seg.get("start", 0.0)),
                    end=float(seg.get("end", 0.0)),
                    score=None,
                )
            )

    return TranscribeResponse(
        transcript=words,
        language=detected_language,
        duration_s=duration_s,
        model=WHISPER_MODEL,
    )


def _probe_duration(audio_path: str) -> float:
    """Cheap duration probe used by stub mode (no whisperx/torch required)."""
    try:
        import wave

        with wave.open(audio_path, "rb") as wf:
            frames = wf.getnframes()
            rate = wf.getframerate()
            if rate > 0:
                return frames / float(rate)
    except Exception:  # noqa: BLE001
        pass
    return 0.0


# Global error handler: always return the ErrorResponse shape for 5xx.
@app.exception_handler(Exception)
async def _global_exc(request: Request, exc: Exception):  # noqa: ARG001
    logger.exception("unhandled error")
    return JSONResponse(
        ErrorResponse(error="internal_error", detail=f"{type(exc).__name__}: {exc}").model_dump(),
        status_code=500,
    )
