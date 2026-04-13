"""V003 — add locked column to episodes

Revision ID: V003_episode_locked
Revises: V002_check_gates
Create Date: 2026-04-13

Changes:
  - episodes: add ``locked`` BOOLEAN column (default false)
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "V003_episode_locked"
down_revision: Union[str, None] = "V002_check_gates"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "episodes",
        sa.Column(
            "locked",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("episodes", "locked")
