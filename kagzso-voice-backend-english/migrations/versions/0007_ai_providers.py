"""ai_provider_settings / ai_provider_selection / ai_provider_audit: the admin page's AI provider settings

Revision ID: 0007_ai_providers
Revises: 0006_call_recordings
Create Date: 2026-10-29
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_ai_providers"
down_revision: Union[str, None] = "0006_call_recordings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # New tables only: no existing table, column or row is changed. With no rows, calls use .env as before.
    op.create_table(
        "ai_provider_settings",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("model", sa.String(100), nullable=True),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("encrypted_key", sa.Text(), nullable=True),
        sa.Column("key_updated_at", sa.DateTime(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=True),
        sa.Column("last_test_status", sa.String(16), nullable=True),
        sa.Column("last_test_message", sa.String(200), nullable=True),
        sa.Column("last_test_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "ai_provider_selection",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("live", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "ai_provider_audit",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("actor", sa.String(120), nullable=True),
        sa.Column("action", sa.String(40), nullable=False),
        sa.Column("provider", sa.String(32), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    # Drops the saved provider settings (and their encrypted keys); calls go back to .env only.
    op.drop_table("ai_provider_audit")
    op.drop_table("ai_provider_selection")
    op.drop_table("ai_provider_settings")
