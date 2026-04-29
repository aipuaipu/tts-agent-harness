"""Register Prefect concurrency limits for rate-limited external APIs.

Per ADR-001 §4.3, the Fish Audio API uses a global concurrency limit
enforced via the ``tts-api`` tag on the P2 task. This module provides
a helper to register (or update) that limit programmatically.

Usage:
    python -m server.flows.concurrency

Or call ``register_limits()`` from the deployment setup script.
"""

from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

# Fish Audio API concurrency limit.
# Adjust based on your API plan tier.
TTS_API_CONCURRENCY = 3


async def register_limits() -> None:
    """Register all concurrency limits with the Prefect server.

    Idempotent: if the limit already exists, it will be updated.
    """
    from prefect.client.orchestration import get_client

    async with get_client() as client:
        # Prefect 3.x API for creating/updating concurrency limits.
        await client.create_concurrency_limit(
            tag="tts-api",
            concurrency_limit=TTS_API_CONCURRENCY,
        )
        log.info(
            "Registered concurrency limit: tts-api = %d",
            TTS_API_CONCURRENCY,
        )


def main() -> None:
    """CLI entry point."""
    logging.basicConfig(level=logging.INFO)
    asyncio.run(register_limits())


if __name__ == "__main__":
    main()


__all__ = ["register_limits", "TTS_API_CONCURRENCY"]
