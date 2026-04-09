"""Smoke test: POST a silent WAV and make sure the /transcribe pipeline
returns a well-formed response.

Runs in stub mode (WHISPERX_STUB_MODE=1 via conftest), so this does NOT
validate any actual transcription quality — it validates the HTTP contract,
multipart handling, and response shape. Real model smoke is done manually
via `docker run` (see README).
"""

from __future__ import annotations

import struct
import time
import wave
from io import BytesIO

from fastapi.testclient import TestClient

import server


def _make_silent_wav(duration_s: float = 1.0, sample_rate: int = 16000) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        n_frames = int(duration_s * sample_rate)
        silence = struct.pack("<h", 0) * n_frames
        wf.writeframes(silence)
    return buf.getvalue()


def test_transcribe_silent_wav_returns_200():
    with TestClient(server.app) as client:
        # Wait for lifespan to mark model as loaded (stub mode is instant).
        deadline = time.time() + 3.0
        while time.time() < deadline and not server.STATE.model_loaded:
            time.sleep(0.05)
        assert server.STATE.model_loaded, "stub mode should mark model loaded immediately"

        wav_bytes = _make_silent_wav(duration_s=1.0)

        r = client.post(
            "/transcribe",
            files={"audio": ("silent.wav", wav_bytes, "audio/wav")},
            data={"language": "zh", "return_word_timestamps": "true"},
        )

        assert r.status_code == 200, r.text
        body = r.json()

        assert "transcript" in body
        assert isinstance(body["transcript"], list)
        # Empty transcript is explicitly allowed for silent audio.
        assert body["language"] == "zh"
        assert "duration_s" in body
        assert body["duration_s"] >= 0.0
        assert "model" in body


def test_transcribe_503_when_model_not_loaded(monkeypatch):
    with TestClient(server.app) as client:
        monkeypatch.setattr(server.STATE, "model_loaded", False)
        wav_bytes = _make_silent_wav(duration_s=0.5)
        r = client.post(
            "/transcribe",
            files={"audio": ("silent.wav", wav_bytes, "audio/wav")},
            data={"language": "zh"},
        )
        assert r.status_code == 503
        body = r.json()
        assert body.get("error") == "model_not_loaded"


def test_transcribe_english_language_accepted():
    with TestClient(server.app) as client:
        deadline = time.time() + 3.0
        while time.time() < deadline and not server.STATE.model_loaded:
            time.sleep(0.05)

        wav_bytes = _make_silent_wav(duration_s=0.5)
        r = client.post(
            "/transcribe",
            files={"audio": ("s.wav", wav_bytes, "audio/wav")},
            data={"language": "en", "return_word_timestamps": "false"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["language"] == "en"
