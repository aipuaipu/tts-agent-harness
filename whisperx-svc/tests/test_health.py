"""Health / readiness endpoint tests.

Verify that /healthz is reachable both during and after model load, and that
/readyz transitions from 503 -> 200 once the lifespan load task completes.
"""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

import server


def test_healthz_shape_during_lifespan():
    # TestClient runs the lifespan startup synchronously before yielding a
    # client. In stub mode, _load_model_blocking sets model_loaded=True
    # immediately, so by the time we hit the endpoint it must be True.
    with TestClient(server.app) as client:
        # Wait up to 3s for the background load executor to finish.
        deadline = time.time() + 3.0
        while time.time() < deadline and not server.STATE.model_loaded:
            time.sleep(0.05)

        r = client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) >= {"model_loaded", "device", "model"}
        assert body["model"] == "large-v3"
        assert body["device"] == "cpu"
        assert body["model_loaded"] is True


def test_readyz_200_after_load():
    with TestClient(server.app) as client:
        deadline = time.time() + 3.0
        while time.time() < deadline and not server.STATE.model_loaded:
            time.sleep(0.05)

        r = client.get("/readyz")
        assert r.status_code == 200
        assert r.json().get("status") == "ready"


def test_readyz_503_when_not_loaded(monkeypatch):
    # Force model_loaded False to simulate cold-start state.
    monkeypatch.setattr(server.STATE, "model_loaded", False)
    with TestClient(server.app) as client:
        # The lifespan will try to re-run the loader and flip it back; wait
        # a moment then force-override again before the request.
        monkeypatch.setattr(server.STATE, "model_loaded", False)
        r = client.get("/readyz")
        assert r.status_code == 503
        assert r.json().get("status") == "loading"
