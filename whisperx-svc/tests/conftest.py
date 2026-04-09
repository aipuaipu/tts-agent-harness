"""Test fixtures.

We force stub mode *before* importing the server module so tests don't need
the multi-GB whisperx model weights.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("WHISPERX_STUB_MODE", "1")
os.environ.setdefault("WHISPER_MODEL", "large-v3")
os.environ.setdefault("WHISPER_DEVICE", "cpu")
os.environ.setdefault("MODEL_CACHE_DIR", "/tmp/whisperx-test-models")

# Make `import server` work when running pytest from the whisperx-svc dir
# or from the repo root.
SVC_DIR = Path(__file__).resolve().parent.parent
if str(SVC_DIR) not in sys.path:
    sys.path.insert(0, str(SVC_DIR))
