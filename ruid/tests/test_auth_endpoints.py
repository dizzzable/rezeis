from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.api.dependencies import (
    get_runtime_settings,
    get_session_service,
    get_session_store,
    get_subscription_service,
)
from app.core.config import get_settings
from app.main import app
from app.schemas.session import SessionSchema
from app.schemas.subscription import SubscriptionSchema
from app.services.internal_admin_client import (
    InternalAdminContractError,
    InternalAdminNotFoundError,
    InternalAdminTimeoutError,
    InternalAdminUpstreamError,
)
from tests.support import (
    InMemorySessionStore,
    build_expected_session,
    build_expected_subscription,
    build_telegram_init_data,
    reset_settings_cache,
)


def test_telegram_bootstrap_returns_cookie_and_payload(monkeypatch) -> None:
    expected_session = build_expected_session()
    expected_subscription = build_expected_subscription()
    session_store = InMemorySessionStore()

    class StubSessionService:
        async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
            assert telegram_id == "777000"
            return expected_session

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            assert user_id == expected_session.id
            return expected_subscription

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_service] = lambda: StubSessionService()
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={
                "Authorization": "tma "
                + build_telegram_init_data(
                    bot_token="test-telegram-token",
                    telegram_id=777000,
                    auth_date=datetime.now(UTC),
                )
            },
        )

    assert response.status_code == 200
    assert response.cookies.get("ruid_session") == "stored-session-id"
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]
    assert response.json()["session"]["id"] == expected_session.id
    assert response.json()["subscription"]["id"] == expected_subscription.id
    assert response.json()["expiresIn"] == 604800
    assert session_store.sessions["stored-session-id"].user_id == expected_session.id


def test_telegram_bootstrap_rejects_invalid_signature(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_store] = lambda: session_store

    invalid_init_data = build_telegram_init_data(
        bot_token="different-token",
        telegram_id=777000,
        auth_date=datetime.now(UTC),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={"Authorization": f"tma {invalid_init_data}"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Telegram init data signature is invalid."}


def test_telegram_bootstrap_rejects_expired_auth_date(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_store] = lambda: session_store

    expired_init_data = build_telegram_init_data(
        bot_token="test-telegram-token",
        telegram_id=777000,
        auth_date=datetime.now(UTC) - timedelta(minutes=10),
    )

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={"Authorization": f"tma {expired_init_data}"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Telegram init data auth_date is too old."}


def test_telegram_bootstrap_maps_missing_user_to_not_found(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    class StubSessionService:
        async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            raise AssertionError("Subscription lookup should not run when the user is missing.")

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_service] = lambda: StubSessionService()
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={
                "Authorization": "tma "
                + build_telegram_init_data(
                    bot_token="test-telegram-token",
                    telegram_id=777000,
                    auth_date=datetime.now(UTC),
                )
            },
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "User not found"}


def test_telegram_bootstrap_rejects_replayed_init_data(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    raw_init_data = build_telegram_init_data(
        bot_token="test-telegram-token",
        telegram_id=777000,
        auth_date=datetime.now(UTC),
    )

    class StubSessionService:
        async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
            return expected_session

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            return None

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_service] = lambda: StubSessionService()
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        first_response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={"Authorization": f"tma {raw_init_data}"},
        )
        second_response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={"Authorization": f"tma {raw_init_data}"},
        )

    assert first_response.status_code == 200
    assert second_response.status_code == 401
    assert second_response.json() == {
        "detail": "Telegram init data was already used to create a session."
    }


def test_telegram_bootstrap_does_not_burn_proof_on_internal_admin_timeout(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    raw_init_data = build_telegram_init_data(
        bot_token="test-telegram-token",
        telegram_id=777000,
        auth_date=datetime.now(UTC),
    )

    class StubSessionService:
        def __init__(self) -> None:
            self.calls = 0

        async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
            self.calls += 1
            if self.calls == 1:
                raise InternalAdminTimeoutError()
            return expected_session

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            return None

    session_service = StubSessionService()
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_service] = lambda: session_service
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        first_response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={"Authorization": f"tma {raw_init_data}"},
        )
        second_response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={"Authorization": f"tma {raw_init_data}"},
        )

    assert first_response.status_code == 504
    assert second_response.status_code == 200
    assert session_store.used_bootstrap_proofs == {raw_init_data}


def test_telegram_bootstrap_succeeds_when_subscription_contract_read_fails(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()

    class StubSessionService:
        async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
            assert telegram_id == "777000"
            return expected_session

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            assert user_id == expected_session.id
            raise InternalAdminContractError()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_service] = lambda: StubSessionService()
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={
                "Authorization": "tma "
                + build_telegram_init_data(
                    bot_token="test-telegram-token",
                    telegram_id=777000,
                    auth_date=datetime.now(UTC),
                )
            },
        )

    assert response.status_code == 200
    assert response.cookies.get("ruid_session") == "stored-session-id"
    assert response.json()["session"]["id"] == expected_session.id
    assert response.json()["subscription"] is None
    assert session_store.sessions["stored-session-id"].user_id == expected_session.id


def test_telegram_bootstrap_succeeds_when_subscription_upstream_times_out(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()

    class StubSessionService:
        async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
            assert telegram_id == "777000"
            return expected_session

    class StubSubscriptionService:
        async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
            assert user_id == expected_session.id
            raise InternalAdminUpstreamError()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_service] = lambda: StubSessionService()
    app.dependency_overrides[get_subscription_service] = lambda: StubSubscriptionService()
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={
                "Authorization": "tma "
                + build_telegram_init_data(
                    bot_token="test-telegram-token",
                    telegram_id=777000,
                    auth_date=datetime.now(UTC),
                )
            },
        )

    assert response.status_code == 200
    assert response.cookies.get("ruid_session") == "stored-session-id"
    assert response.json()["session"]["id"] == expected_session.id
    assert response.json()["subscription"] is None


def test_telegram_bootstrap_rejects_missing_origin(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-telegram-token")
    monkeypatch.setenv("TELEGRAM_AUTH_MAX_AGE_SECONDS", "300")
    monkeypatch.setenv("RUID_PUBLIC_WEB_URL", "https://miniapp.example.com")
    reset_settings_cache()
    app.dependency_overrides[get_runtime_settings] = get_settings
    app.dependency_overrides[get_session_store] = lambda: session_store

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/auth/telegram/bootstrap",
            headers={
                "Authorization": "tma "
                + build_telegram_init_data(
                    bot_token="test-telegram-token",
                    telegram_id=777000,
                    auth_date=datetime.now(UTC),
                )
            },
        )

    assert response.status_code == 403
    assert response.json() == {"detail": "Browser origin header is required."}
