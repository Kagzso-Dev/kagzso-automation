"""call_latency_metrics: end-of-speech wait, TTS wait, full reply delay and reply source per turn

Revision ID: 0005_latency_detail
Revises: 0004_call_voice
Create Date: 2026-10-18
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_latency_detail"
down_revision: Union[str, None] = "0004_call_voice"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Additive and nullable: existing rows and readers are unaffected.
    op.add_column("call_latency_metrics", sa.Column("eos_wait_ms", sa.Integer(), nullable=True))
    op.add_column("call_latency_metrics", sa.Column("tts_wait_ms", sa.Integer(), nullable=True))
    op.add_column("call_latency_metrics", sa.Column("reply_delay_ms", sa.Integer(), nullable=True))
    op.add_column("call_latency_metrics", sa.Column("reply_source", sa.String(16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("call_latency_metrics") as b:
        b.drop_column("reply_source")
        b.drop_column("reply_delay_ms")
        b.drop_column("tts_wait_ms")
        b.drop_column("eos_wait_ms")
