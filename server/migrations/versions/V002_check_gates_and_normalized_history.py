"""V002 — add check gate stages and normalized_history

Revision ID: V002_check_gates
Revises: V001_initial
Create Date: 2026-04-12

Changes:
  - chunks: add ``normalized_history`` JSONB column (default [])
  - StageName enum extended to include p1c, p2c, p2v, p6v (no DDL change
    needed — stage_runs.stage is TEXT, not a Postgres ENUM).
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "V002_check_gates"
down_revision: Union[str, None] = "V001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chunks",
        sa.Column(
            "normalized_history",
            postgresql.JSONB(),
            server_default="[]",
            nullable=False,
        ),
    )
    # Migrate old "transcribed" status to "verified"
    op.execute("UPDATE chunks SET status = 'verified' WHERE status = 'transcribed'")


def downgrade() -> None:
    op.drop_column("chunks", "normalized_history")
