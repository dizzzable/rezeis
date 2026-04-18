from __future__ import annotations

import os

import pytest

os.environ.setdefault("REZEIS_INTERNAL_API_KEY", "test-internal-key")
os.environ.setdefault("REZEIS_BASE_URL", "http://rezeis-admin-api:3000")
os.environ.setdefault("REZEIS_HOST", "rezeis-admin-api")
os.environ.setdefault("REZEIS_PORT", "3000")
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")

from app.core.config import get_settings
from app.main import app


@pytest.fixture(autouse=True)
def reset_test_state() -> None:
    app.dependency_overrides.clear()
    get_settings.cache_clear()
    for attribute_name in ("internal_admin_client", "redis_client", "session_store"):
        if hasattr(app.state, attribute_name):
            delattr(app.state, attribute_name)
    yield
    app.dependency_overrides.clear()
    get_settings.cache_clear()
    for attribute_name in ("internal_admin_client", "redis_client", "session_store"):
        if hasattr(app.state, attribute_name):
            delattr(app.state, attribute_name)
