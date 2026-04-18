from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.dependencies import get_runtime_settings, get_session_store, get_subscription_service
from app.core.config import get_settings
from app.main import app
from app.schemas.subscription import SubscriptionSchema
from app.services.internal_admin_client import InternalAdminNotFoundError
from tests.support import (
    InMemorySessionStore,
    build_auth_session,
    build_expected_session,
    build_expected_subscription,
    reset_settings_cache,
)


def test_subscription_endpoint_returns_typed_payload_from_session_cookie() -> None:
    expected_session = build_expected_session()
    expected_subscription = build_expected_subscription()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            assert user_id == expected_session.id
            return expected_subscription

    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.get("/api/v1/subscription")

    assert response.status_code == 200
    assert response.json()["id"] == expected_subscription.id


def test_subscription_endpoint_returns_null_when_user_has_no_subscription() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            assert user_id == expected_session.id
            return None

    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.get("/api/v1/subscription")

    assert response.status_code == 200
    assert response.json() is None


def test_subscription_endpoint_invalidates_stale_upstream_user(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.get("/api/v1/subscription")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]
