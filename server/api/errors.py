"""Unified error handling — three layers of exception handlers.

1. DomainError     → business errors → mapped HTTP status (4xx/5xx)
2. ValidationError → Pydantic schema mismatch → 422
3. Exception       → catch-all → 500 with structured body

All error responses follow the shape:

    {"error": "<code>", "detail": "<message>"}
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from server.core.domain import DomainError

log = logging.getLogger(__name__)

# --- code → HTTP status mapping -------------------------------------------

_STATUS_MAP: dict[str, int] = {
    "not_found": 404,
    "invalid_input": 422,
    "invalid_state": 409,
    "lock_busy": 423,
    "internal": 500,
}


def _status_for(code: str) -> int:
    return _STATUS_MAP.get(code, 500)


# --- handlers --------------------------------------------------------------


async def domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
    return JSONResponse(
        status_code=_status_for(exc.code),
        content={"error": exc.code, "detail": exc.message},
    )


async def validation_error_handler(_request: Request, exc: ValidationError) -> JSONResponse:
    """Pydantic validation failures — e.g. DB has value not in Literal type."""
    log.warning("Pydantic validation error: %s", exc)
    return JSONResponse(
        status_code=422,
        content={
            "error": "validation_error",
            "detail": str(exc),
        },
    )


async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Catch-all for unexpected exceptions — never return bare 500."""
    log.exception("Unhandled exception on %s %s", _request.method, _request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal",
            "detail": f"{type(exc).__name__}: {exc}",
        },
    )


def install_error_handlers(app: FastAPI) -> None:
    """Register exception handlers and middleware on *app*."""
    app.add_exception_handler(DomainError, domain_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(ValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, unhandled_error_handler)  # type: ignore[arg-type]

    # Middleware catch-all: FastAPI's response serialization errors bypass
    # exception handlers (they happen after the route returns). This
    # middleware wraps every request so even those errors get a JSON body.
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request as StarletteRequest
    from starlette.responses import Response

    class CatchAllMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: StarletteRequest, call_next) -> Response:  # type: ignore[override]
            try:
                return await call_next(request)
            except Exception as exc:
                log.exception("Middleware caught unhandled error on %s %s", request.method, request.url.path)
                return JSONResponse(
                    status_code=500,
                    content={"error": "internal", "detail": f"{type(exc).__name__}: {exc}"},
                )

    app.add_middleware(CatchAllMiddleware)
