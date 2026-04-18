from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.endpoints import session as session_endpoints
from app.api.dependencies import get_runtime_settings, get_session_service, get_session_store
from app.core.config import get_settings
from app.main import app
from app.schemas.session import SessionSchema
from app.schemas.session_web_account_email_verification_completion import (
    SessionWebAccountEmailVerificationCompletionSchema,
)
from app.schemas.web_account_email_verification_challenge import (
    WebAccountEmailVerificationChallengeSchema,
)
from app.services.internal_admin_client import (
    InternalAdminActionablePasswordHandoffError,
    InternalAdminActionableEmailVerificationCompletionError,
    InternalAdminContractError,
    InternalAdminNonActionablePromptError,
    InternalAdminNotFoundError,
)
from app.services.session_service import SessionService
from tests.support import (
    InMemorySessionStore,
    build_auth_session,
    build_expected_session,
    reset_settings_cache,
)


def override_session_dependencies(
    *,
    session_store: InMemorySessionStore,
    session_service: object | None = None,
    include_runtime_settings: bool = False,
) -> None:
    if include_runtime_settings:
        app.dependency_overrides[get_runtime_settings] = get_settings
    if session_service is not None:
        app.dependency_overrides[get_session_service] = lambda: session_service
    app.dependency_overrides[get_session_store] = lambda: session_store


def build_expected_session_with_web_account(
    *,
    email: str | None = "user@example.com",
    email_normalized: str | None = "user@example.com",
    email_verified_at: str | None = None,
) -> SessionSchema:
    base_session = build_expected_session()
    payload = base_session.model_dump(by_alias=True)
    payload["webAccount"] = {
        "id": "22222222-2222-2222-2222-222222222222",
        "login": "user-login",
        "loginNormalized": "user-login",
        "email": email,
        "emailNormalized": email_normalized,
        "emailVerifiedAt": email_verified_at,
        "requiresPasswordChange": False,
        "linkPromptSnoozeUntil": None,
        "credentialsBootstrappedAt": "2026-04-17T05:00:00Z",
        "createdAt": "2026-04-17T05:00:00Z",
        "updatedAt": "2026-04-17T05:00:00Z",
    }
    return SessionSchema.model_validate(payload)


@pytest.mark.parametrize(
    ("method", "path", "json_body"),
    [
        ("get", "/api/v1/session", None),
        ("patch", "/api/v1/session/rules-acceptance", None),
        ("patch", "/api/v1/session/web-account-link-prompt-snooze", None),
        (
            "patch",
            "/api/v1/session/web-account-password",
            {"login": "user-login", "password": "new-password-123"},
        ),
        ("patch", "/api/v1/session/web-account-email-verification-challenge", None),
        (
            "patch",
            "/api/v1/session/web-account-email-verification-completion",
            {"code": "123456"},
        ),
    ],
)
def test_session_routes_invalidates_malformed_backing_session_object(
    monkeypatch,
    method: str,
    path: str,
    json_body: dict[str, str] | None,
) -> None:
    session_store = InMemorySessionStore()
    actual_validation_errors: list[ValidationError] = []

    class MalformedAuthSession:
        created_at = "2026-04-17T00:00:00Z"

    session_store.sessions["stored-session-id"] = MalformedAuthSession()  # type: ignore[assignment]
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )
    original_model_validate = session_endpoints.AuthSessionSchema.model_validate

    def capture_model_validate(value: object) -> object:
        try:
            return original_model_validate(value)
        except ValidationError as err:
            actual_validation_errors.append(err)
            raise

    monkeypatch.setattr(
        session_endpoints.AuthSessionSchema,
        "model_validate",
        capture_model_validate,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = getattr(client, method)(path, json=json_body)

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert len(actual_validation_errors) == 1
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_session_endpoint_returns_typed_payload_from_session_cookie() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.get("/api/v1/session")

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id


def test_accept_rules_endpoint_returns_typed_payload_from_session_cookie() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def accept_rules_by_user_id(self, user_id: str) -> SessionSchema:
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/rules-acceptance")

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id


def test_snooze_web_account_link_prompt_endpoint_returns_typed_payload_from_session_cookie() -> (
    None
):
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id


def test_snooze_web_account_link_prompt_endpoint_returns_refreshed_session_for_non_actionable_prompt() -> (
    None
):
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)
    snooze_calls_count = 0
    get_calls_count = 0

    class StubSessionService:
        async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
            nonlocal snooze_calls_count
            snooze_calls_count += 1
            assert user_id == expected_session.id
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            nonlocal get_calls_count
            get_calls_count += 1
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id
    assert snooze_calls_count == 1
    assert get_calls_count == 1
    assert session_store.deleted_session_ids == []


def test_web_account_password_endpoint_returns_typed_payload_from_session_cookie() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            assert user_id == expected_session.id
            assert input.model_dump() == {"login": "user-login", "password": "new-password-123"}
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id


def test_web_account_password_endpoint_returns_actionable_login_conflict() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            assert user_id == expected_session.id
            assert input.model_dump() == {"login": "user-login", "password": "new-password-123"}
            raise InternalAdminActionablePasswordHandoffError("webAccount login is already taken")

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 400
    assert response.json() == {"detail": "webAccount login is already taken"}
    assert session_store.deleted_session_ids == []


def test_web_account_password_endpoint_rejects_whitespace_only_login() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            raise AssertionError("service should not be called for invalid request payload")

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "   ", "password": "new-password-123"},
        )

    assert response.status_code == 422


def test_web_account_email_verification_challenge_endpoint_returns_typed_payload_from_session_cookie() -> (
    None
):
    expected_session = build_expected_session()
    expected_challenge = WebAccountEmailVerificationChallengeSchema.model_validate(
        {
            "webAccountId": "22222222-2222-2222-2222-222222222222",
            "email": "user@example.com",
            "challengeExpiresAt": "2026-04-17T05:15:00Z",
            "emailVerifiedAt": None,
        }
    )
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            assert user_id == expected_session.id
            return expected_challenge

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 200
    assert response.json() == {
        "webAccountId": "22222222-2222-2222-2222-222222222222",
        "email": "user@example.com",
        "challengeExpiresAt": "2026-04-17T05:15:00Z",
        "emailVerifiedAt": None,
    }


def test_web_account_email_verification_completion_endpoint_returns_typed_payload_from_session_cookie() -> (
    None
):
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            assert user_id == expected_session.id
            assert input.model_dump() == {"code": "123456"}
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id


def test_web_account_email_verification_completion_endpoint_returns_refreshed_session_for_non_actionable_write() -> (
    None
):
    expected_session = build_expected_session_with_web_account(
        email_verified_at="2026-04-17T05:30:00Z"
    )
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)
    completion_calls_count = 0
    get_calls_count = 0

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            nonlocal completion_calls_count
            completion_calls_count += 1
            assert user_id == expected_session.id
            assert input.model_dump() == {"code": "123456"}
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            nonlocal get_calls_count
            get_calls_count += 1
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id
    assert completion_calls_count == 1
    assert get_calls_count == 1
    assert session_store.deleted_session_ids == []


def test_web_account_email_verification_completion_endpoint_returns_refreshed_missing_email_state_for_non_actionable_write() -> (
    None
):
    expected_session = build_expected_session_with_web_account(
        email=None,
        email_normalized=None,
    )
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            assert user_id == expected_session.id
            assert input.model_dump() == {"code": "123456"}
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 200
    assert response.json()["webAccount"] is not None
    assert response.json()["webAccount"]["email"] is None
    assert response.json()["webAccount"]["emailNormalized"] is None


@pytest.mark.parametrize(
    "detail",
    [
        "active email verification challenge not found",
        "invalid email verification code",
    ],
)
def test_web_account_email_verification_completion_endpoint_returns_actionable_domain_failure(
    detail: str,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            assert user_id == expected_session.id
            assert input.model_dump() == {"code": "123456"}
            raise InternalAdminActionableEmailVerificationCompletionError(detail)

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 400
    assert response.json() == {"detail": detail}
    assert session_store.deleted_session_ids == []


def test_web_account_email_verification_challenge_endpoint_returns_refreshed_verified_state_for_non_actionable_write() -> (
    None
):
    expected_session = build_expected_session_with_web_account(
        email_verified_at="2026-04-17T05:30:00Z"
    )
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)
    issue_calls_count = 0
    get_calls_count = 0

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            nonlocal issue_calls_count
            issue_calls_count += 1
            assert user_id == expected_session.id
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            nonlocal get_calls_count
            get_calls_count += 1
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 200
    assert response.json() == {
        "webAccountId": expected_session.web_account.id,
        "email": expected_session.web_account.email,
        "challengeExpiresAt": None,
        "emailVerifiedAt": "2026-04-17T05:30:00Z",
    }
    assert issue_calls_count == 1
    assert get_calls_count == 1
    assert session_store.deleted_session_ids == []


def test_web_account_email_verification_challenge_endpoint_returns_refreshed_missing_email_state_for_non_actionable_write() -> (
    None
):
    expected_session = build_expected_session_with_web_account(
        email=None,
        email_normalized=None,
    )
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 200
    assert response.json() == {
        "webAccountId": expected_session.web_account.id,
        "email": None,
        "challengeExpiresAt": None,
        "emailVerifiedAt": None,
    }


def test_web_account_email_verification_challenge_endpoint_returns_refreshed_missing_web_account_state_for_non_actionable_write() -> (
    None
):
    expected_session = build_expected_session().model_copy(update={"web_account": None})
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 200
    assert response.json() == {
        "webAccountId": None,
        "email": None,
        "challengeExpiresAt": None,
        "emailVerifiedAt": None,
    }


def test_web_account_password_endpoint_returns_refreshed_session_for_non_actionable_handoff() -> (
    None
):
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)
    handoff_calls_count = 0
    get_calls_count = 0

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            nonlocal handoff_calls_count
            handoff_calls_count += 1
            assert user_id == expected_session.id
            assert input.model_dump() == {"login": "user-login", "password": "new-password-123"}
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            nonlocal get_calls_count
            get_calls_count += 1
            assert user_id == expected_session.id
            return expected_session

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 200
    assert response.json()["id"] == expected_session.id
    assert handoff_calls_count == 1
    assert get_calls_count == 1
    assert session_store.deleted_session_ids == []


def test_session_endpoint_invalidates_stale_upstream_user(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.get("/api/v1/session")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_accept_rules_endpoint_invalidates_stale_upstream_user(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def accept_rules_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/rules-acceptance")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_snooze_web_account_link_prompt_endpoint_invalidates_stale_upstream_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_password_endpoint_invalidates_stale_upstream_user(monkeypatch) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_challenge_endpoint_invalidates_stale_upstream_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_completion_endpoint_invalidates_stale_upstream_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_completion_endpoint_invalidates_malformed_refresh_session_payload(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_completion_endpoint_invalidates_session_when_refresh_finds_stale_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_challenge_endpoint_invalidates_malformed_refresh_session_payload(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_challenge_endpoint_invalidates_session_when_refresh_finds_stale_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


@pytest.mark.parametrize(
    ("method", "path", "json_body"),
    [
        ("get", "/api/v1/session", None),
        ("patch", "/api/v1/session/rules-acceptance", None),
        (
            "patch",
            "/api/v1/session/web-account-link-prompt-snooze",
            None,
        ),
        (
            "patch",
            "/api/v1/session/web-account-password",
            {"password": "new-password-123"},
        ),
        (
            "patch",
            "/api/v1/session/web-account-email-verification-challenge",
            None,
        ),
        (
            "patch",
            "/api/v1/session/web-account-email-verification-completion",
            {"code": "123456"},
        ),
    ],
)
def test_session_routes_invalidates_malformed_upstream_session_payload(
    monkeypatch,
    method: str,
    path: str,
    json_body: dict[str, str] | None,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

        async def accept_rules_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

        async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            raise InternalAdminContractError()

        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise InternalAdminContractError()

        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            raise InternalAdminContractError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = getattr(client, method)(path, json=json_body)

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_snooze_web_account_link_prompt_endpoint_invalidates_malformed_refresh_session_payload(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_snooze_web_account_link_prompt_endpoint_invalidates_session_when_refresh_finds_stale_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_session_endpoint_rejects_missing_backing_session(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "corrupt-session")
        response = client.get("/api/v1/session")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is missing or expired."}
    assert session_store.deleted_session_ids == []
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_accept_rules_endpoint_rejects_missing_backing_session(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "corrupt-session")
        response = client.patch("/api/v1/session/rules-acceptance")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is missing or expired."}
    assert session_store.deleted_session_ids == []
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_snooze_web_account_link_prompt_endpoint_rejects_missing_backing_session(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "corrupt-session")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is missing or expired."}
    assert session_store.deleted_session_ids == []
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_password_endpoint_rejects_missing_backing_session(monkeypatch) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "corrupt-session")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is missing or expired."}
    assert session_store.deleted_session_ids == []
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_challenge_endpoint_rejects_missing_backing_session(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "corrupt-session")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is missing or expired."}
    assert session_store.deleted_session_ids == []
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_completion_endpoint_rejects_missing_backing_session(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "corrupt-session")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is missing or expired."}
    assert session_store.deleted_session_ids == []
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_accept_rules_endpoint_invalidates_corrupt_backing_session_user_id(monkeypatch) -> None:
    session_store = InMemorySessionStore()
    patch_calls_count = 0

    class CorruptAuthSession:
        user_id = "not-a-uuid"

    class StubInternalAdminClient:
        async def patch_json(self, path: str, params: dict[str, str]) -> object:
            nonlocal patch_calls_count
            patch_calls_count += 1
            return {}

    session_store.sessions["stored-session-id"] = CorruptAuthSession()  # type: ignore[assignment]
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=SessionService(StubInternalAdminClient()),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/rules-acceptance")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert patch_calls_count == 0
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_snooze_web_account_link_prompt_endpoint_invalidates_corrupt_backing_session_user_id(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()
    patch_calls_count = 0

    class CorruptAuthSession:
        user_id = "not-a-uuid"

    class StubInternalAdminClient:
        async def patch_json(self, path: str, params: dict[str, str]) -> object:
            nonlocal patch_calls_count
            patch_calls_count += 1
            return {}

    session_store.sessions["stored-session-id"] = CorruptAuthSession()  # type: ignore[assignment]
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=SessionService(StubInternalAdminClient()),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-link-prompt-snooze")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert patch_calls_count == 0
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_password_endpoint_invalidates_corrupt_backing_session_user_id(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()
    patch_calls_count = 0

    class CorruptAuthSession:
        user_id = "not-a-uuid"

    class StubInternalAdminClient:
        async def patch_web_account_password(
            self, *, user_id: str, login: str, password: str
        ) -> object:
            nonlocal patch_calls_count
            patch_calls_count += 1
            return {}

    session_store.sessions["stored-session-id"] = CorruptAuthSession()  # type: ignore[assignment]
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=SessionService(StubInternalAdminClient()),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert patch_calls_count == 0
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_challenge_endpoint_invalidates_corrupt_backing_session_user_id(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()
    patch_calls_count = 0

    class CorruptAuthSession:
        user_id = "not-a-uuid"

    class StubInternalAdminClient:
        async def patch_web_account_email_verification_challenge(self, *, user_id: str) -> object:
            nonlocal patch_calls_count
            patch_calls_count += 1
            return {}

    session_store.sessions["stored-session-id"] = CorruptAuthSession()  # type: ignore[assignment]
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=SessionService(StubInternalAdminClient()),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert patch_calls_count == 0
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_completion_endpoint_invalidates_corrupt_backing_session_user_id(
    monkeypatch,
) -> None:
    session_store = InMemorySessionStore()
    patch_calls_count = 0

    class CorruptAuthSession:
        user_id = "not-a-uuid"

    class StubInternalAdminClient:
        async def patch_web_account_email_verification_completion(
            self,
            *,
            user_id: str,
            code: str,
        ) -> object:
            nonlocal patch_calls_count
            patch_calls_count += 1
            return {}

    session_store.sessions["stored-session-id"] = CorruptAuthSession()  # type: ignore[assignment]
    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=SessionService(StubInternalAdminClient()),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert patch_calls_count == 0
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_email_verification_challenge_endpoint_keeps_unrelated_upstream_failure_distinguishable() -> (
    None
):
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def issue_web_account_email_verification_challenge_by_user_id(
            self,
            user_id: str,
        ) -> WebAccountEmailVerificationChallengeSchema:
            raise RuntimeError("boom")

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch("/api/v1/session/web-account-email-verification-challenge")

    assert response.status_code == 500
    assert session_store.deleted_session_ids == []


def test_web_account_email_verification_completion_endpoint_keeps_unrelated_upstream_failure_distinguishable() -> (
    None
):
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def complete_web_account_email_verification_by_user_id(
            self,
            user_id: str,
            input: SessionWebAccountEmailVerificationCompletionSchema,
        ) -> SessionSchema:
            raise RuntimeError("boom")

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-email-verification-completion",
            json={"code": "123456"},
        )

    assert response.status_code == 500
    assert session_store.deleted_session_ids == []


def test_web_account_password_endpoint_keeps_unrelated_upstream_failure_distinguishable() -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            raise RuntimeError("boom")

    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
    )

    with TestClient(app, raise_server_exceptions=False) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 500
    assert session_store.deleted_session_ids == []


def test_web_account_password_endpoint_invalidates_malformed_refresh_session_payload(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminContractError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert response.headers["set-cookie"].startswith("ruid_session=")
    assert "Max-Age=0" in response.headers["set-cookie"]


def test_web_account_password_endpoint_invalidates_session_when_refresh_finds_stale_user(
    monkeypatch,
) -> None:
    expected_session = build_expected_session()
    session_store = InMemorySessionStore()
    session_store.sessions["stored-session-id"] = build_auth_session(user_id=expected_session.id)

    class StubSessionService:
        async def handoff_web_account_password_by_user_id(
            self,
            user_id: str,
            input: object,
        ) -> SessionSchema:
            raise InternalAdminNonActionablePromptError()

        async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
            raise InternalAdminNotFoundError()

    monkeypatch.setenv("RUID_SESSION_COOKIE_SECURE", "true")
    reset_settings_cache()
    override_session_dependencies(
        session_store=session_store,
        session_service=StubSessionService(),
        include_runtime_settings=True,
    )

    with TestClient(app) as client:
        client.cookies.set("ruid_session", "stored-session-id")
        response = client.patch(
            "/api/v1/session/web-account-password",
            json={"login": "user-login", "password": "new-password-123"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Session is no longer valid."}
    assert session_store.deleted_session_ids == ["stored-session-id"]
    assert "ruid_session=" in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]
