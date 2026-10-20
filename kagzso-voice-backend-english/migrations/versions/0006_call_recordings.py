"""call_recordings: one stereo recording per answered call (CALL_RECORDING_ENABLED)

Revision ID: 0006_call_recordings
Revises: 0005_latency_detail
Create Date: 2026-10-20
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_call_recordings"
down_revision: Union[str, None] = "0005_latency_detail"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A new table only: no existing table, column or row is changed.
    op.create_table(
        "call_recordings",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("call_id", sa.String(32), sa.ForeignKey("calls.id", ondelete="CASCADE"), nullable=False),
        sa.Column("storage_key", sa.String(128), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("error", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("call_id", name="uq_call_recordings_call_id"),
    )
    op.create_index("ix_call_recordings_status_created", "call_recordings", ["status", "created_at"])


def downgrade() -> None:
    # Drops the recordings table only. Recording files in RECORDINGS_DIR are left on disk.
    op.drop_index("ix_call_recordings_status_created", table_name="call_recordings")
    op.drop_table("call_recordings")
