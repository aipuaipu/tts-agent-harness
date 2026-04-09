"""Shared pytest fixtures for the ``server.core`` test suite.

Three categories of fixture:

1. ``session`` — SQLite in-memory ``AsyncSession``. Creates all tables via
   ``Base.metadata.create_all``. Fast, always available, no docker required.

2. ``pg_session`` — Postgres ``AsyncSession`` backed by a testcontainer.
   Gated on docker availability: when docker is missing the fixture is
   marked as skipped instead of erroring out, so developers without docker
   still get a useful test run.

3. ``minio_client`` — a plain (sync) ``minio.Minio`` client pointed at a
   testcontainers MinIO instance, plus its ``endpoint`` / credentials /
   pre-created bucket. Also gated on docker.

The docker gating makes the suite practically runnable on any laptop: the
SQLite subset must pass everywhere; the Postgres + MinIO subsets only run
when docker-compatible runtime is available.
"""

from __future__ import annotations

import os
import shutil
import socket
import uuid
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from server.core.models import Base


# ---------------------------------------------------------------------------
# Docker detection
# ---------------------------------------------------------------------------


def _docker_available() -> bool:
    if os.getenv("SKIP_DOCKER_TESTS") == "1":
        return False
    if shutil.which("docker") is None:
        return False
    # Probe the docker socket without actually running a container.
    sock_paths = [
        "/var/run/docker.sock",
        os.path.expanduser("~/.docker/run/docker.sock"),
        os.path.expanduser("~/.colima/default/docker.sock"),
    ]
    for p in sock_paths:
        if os.path.exists(p):
            return True
    # Fall back to a TCP probe on DOCKER_HOST if set.
    docker_host = os.getenv("DOCKER_HOST", "")
    if docker_host.startswith("tcp://"):
        try:
            host, _, port = docker_host[len("tcp://") :].partition(":")
            with socket.create_connection((host, int(port or 2375)), timeout=0.5):
                return True
        except OSError:
            return False
    return False


DOCKER_AVAILABLE = _docker_available()

requires_docker = pytest.mark.skipif(
    not DOCKER_AVAILABLE,
    reason="docker not available on this host (SKIP_DOCKER_TESTS or no docker binary)",
)


# ---------------------------------------------------------------------------
# SQLite session (always available)
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture()
async def session() -> AsyncIterator[AsyncSession]:
    """Fresh in-memory SQLite DB per test."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        future=True,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as sess:
        yield sess
    await engine.dispose()


# ---------------------------------------------------------------------------
# Postgres session (testcontainers)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def pg_container() -> Iterator[object]:
    if not DOCKER_AVAILABLE:
        pytest.skip("docker not available")

    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16-alpine") as pg:
        yield pg


@pytest_asyncio.fixture()
async def pg_session(pg_container) -> AsyncIterator[AsyncSession]:  # type: ignore[valid-type]
    # Convert the sync SQLAlchemy URL that testcontainers exposes into an
    # asyncpg URL.
    sync_url = pg_container.get_connection_url()
    async_url = sync_url.replace("postgresql+psycopg2", "postgresql+asyncpg")
    if "+asyncpg" not in async_url:
        async_url = async_url.replace("postgresql://", "postgresql+asyncpg://")

    engine = create_async_engine(async_url, future=True)
    # Make sure each test starts with a clean schema.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as sess:
        yield sess
    await engine.dispose()


# ---------------------------------------------------------------------------
# MinIO client (testcontainers)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def minio_container() -> Iterator[object]:
    if not DOCKER_AVAILABLE:
        pytest.skip("docker not available")

    from testcontainers.minio import MinioContainer

    with MinioContainer() as mc:
        yield mc


@pytest.fixture()
def minio_settings(minio_container):  # type: ignore[valid-type]
    from server.core.storage import MinIOSettings

    config = minio_container.get_config()
    # MinioContainer returns keys like ``endpoint`` / ``access_key`` / ``secret_key``.
    endpoint = config["endpoint"]
    access_key = config["access_key"]
    secret_key = config["secret_key"]
    bucket = f"test-{uuid.uuid4().hex[:8]}"
    return MinIOSettings(
        endpoint=endpoint,
        access_key=access_key,
        secret_key=secret_key,
        bucket=bucket,
        secure=False,
    )


@pytest.fixture()
def minio_client(minio_settings):
    from server.core.storage import MinIOStorage

    return MinIOStorage(
        endpoint=minio_settings.endpoint,
        access_key=minio_settings.access_key,
        secret_key=minio_settings.secret_key,
        bucket=minio_settings.bucket,
        secure=minio_settings.secure,
    )
