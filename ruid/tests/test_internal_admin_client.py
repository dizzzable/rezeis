from __future__ import annotations

import json

import httpx
import pytest

from app.services.internal_admin_client import (
    InternalAdminActionablePasswordHandoffError,
    InternalAdminActionableEmailVerificationCompletionError,
    InternalAdminContractError,
    InternalAdminNonActionablePromptError,
    InternalAdminNotFoundError,
    InternalAdminTimeoutError,
    InternalAdminUpstreamError,
    build_internal_admin_client,
)
from app.schemas.session_web_account_email_verification_completion import (
    SessionWebAccountEmailVerificationCompletionSchema,
)
from app.schemas.session_web_account_password import SessionWebAccountPasswordSchema
from app.services.plans_service import PlansService
from app.services.platform_policy_service import PlatformPolicyService
from app.services.session_service import SessionService


@pytest.mark.asyncio
async def test_internal_admin_client_sends_internal_api_key() -> None:
    captured_headers: dict[str, str] = {}

    async def handle_request(request: httpx.Request) -> httpx.Response:
        captured_headers.update(request.headers)
        return httpx.Response(status_code=200, json={"ok": True})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    await client.get_json("/api/internal/user/plans")
    await client.close()

    assert captured_headers["x-internal-api-key"] == "secret-key"


@pytest.mark.asyncio
async def test_internal_admin_client_sends_rules_acceptance_patch_request() -> None:
    captured_method: str | None = None
    captured_path: str | None = None
    captured_query: str | None = None
    captured_content: bytes | None = None

    async def handle_request(request: httpx.Request) -> httpx.Response:
        nonlocal captured_method, captured_path, captured_query, captured_content
        captured_method = request.method
        captured_path = request.url.path
        captured_query = request.url.query.decode("utf-8")
        captured_content = request.content
        return httpx.Response(status_code=200, json={"ok": True})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    await client.patch_json(
        "/api/internal/user/session/rules-acceptance",
        params={"userId": "11111111-1111-1111-1111-111111111111"},
    )
    await client.close()

    assert captured_method == "PATCH"
    assert captured_path == "/api/internal/user/session/rules-acceptance"
    assert captured_query == "userId=11111111-1111-1111-1111-111111111111"
    assert captured_content == b""


@pytest.mark.asyncio
async def test_internal_admin_client_sends_web_account_link_prompt_snooze_patch_request() -> None:
    captured_method: str | None = None
    captured_path: str | None = None
    captured_query: str | None = None
    captured_content: bytes | None = None

    async def handle_request(request: httpx.Request) -> httpx.Response:
        nonlocal captured_method, captured_path, captured_query, captured_content
        captured_method = request.method
        captured_path = request.url.path
        captured_query = request.url.query.decode("utf-8")
        captured_content = request.content
        return httpx.Response(status_code=200, json={"ok": True})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    await client.patch_json(
        "/api/internal/user/session/web-account-link-prompt-snooze",
        params={"userId": "11111111-1111-1111-1111-111111111111"},
    )
    await client.close()

    assert captured_method == "PATCH"
    assert captured_path == "/api/internal/user/session/web-account-link-prompt-snooze"
    assert captured_query == "userId=11111111-1111-1111-1111-111111111111"
    assert captured_content == b""


@pytest.mark.asyncio
async def test_internal_admin_client_sends_web_account_password_patch_request() -> None:
    captured_method: str | None = None
    captured_path: str | None = None
    captured_query: str | None = None
    captured_content: bytes | None = None

    async def handle_request(request: httpx.Request) -> httpx.Response:
        nonlocal captured_method, captured_path, captured_query, captured_content
        captured_method = request.method
        captured_path = request.url.path
        captured_query = request.url.query.decode("utf-8")
        captured_content = request.content
        return httpx.Response(status_code=200, json={"ok": True})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    await client.patch_web_account_password(
        user_id="11111111-1111-1111-1111-111111111111",
        login="user-login",
        password="new-password-123",
    )
    await client.close()

    assert captured_method == "PATCH"
    assert captured_path == "/api/internal/user/session/web-account-password"
    assert captured_query == ""
    assert json.loads(captured_content) == {
        "userId": "11111111-1111-1111-1111-111111111111",
        "login": "user-login",
        "password": "new-password-123",
    }


@pytest.mark.asyncio
async def test_internal_admin_client_sends_web_account_email_verification_challenge_patch_request() -> (
    None
):
    captured_method: str | None = None
    captured_path: str | None = None
    captured_query: str | None = None
    captured_content: bytes | None = None

    async def handle_request(request: httpx.Request) -> httpx.Response:
        nonlocal captured_method, captured_path, captured_query, captured_content
        captured_method = request.method
        captured_path = request.url.path
        captured_query = request.url.query.decode("utf-8")
        captured_content = request.content
        return httpx.Response(status_code=200, json={"ok": True})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    await client.patch_web_account_email_verification_challenge(
        user_id="11111111-1111-1111-1111-111111111111"
    )
    await client.close()

    assert captured_method == "PATCH"
    assert captured_path == "/api/internal/user/session/web-account-email-verification-challenge"
    assert captured_query == ""
    assert json.loads(captured_content) == {
        "userId": "11111111-1111-1111-1111-111111111111",
    }


@pytest.mark.asyncio
async def test_internal_admin_client_sends_web_account_email_verification_completion_patch_request() -> (
    None
):
    captured_method: str | None = None
    captured_path: str | None = None
    captured_query: str | None = None
    captured_content: bytes | None = None

    async def handle_request(request: httpx.Request) -> httpx.Response:
        nonlocal captured_method, captured_path, captured_query, captured_content
        captured_method = request.method
        captured_path = request.url.path
        captured_query = request.url.query.decode("utf-8")
        captured_content = request.content
        return httpx.Response(status_code=200, json={"ok": True})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    await client.patch_web_account_email_verification_completion(
        user_id="11111111-1111-1111-1111-111111111111",
        code="123456",
    )
    await client.close()

    assert captured_method == "PATCH"
    assert captured_path == "/api/internal/user/session/web-account-email-verification-completion"
    assert captured_query == ""
    assert json.loads(captured_content) == {
        "userId": "11111111-1111-1111-1111-111111111111",
        "code": "123456",
    }


@pytest.mark.asyncio
async def test_internal_admin_client_raises_contract_error_for_invalid_json() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=200, content=b"not-json")

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminContractError):
        await client.get_json("/api/internal/user/plans")

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_not_found_error_for_404() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=404, json={"detail": "missing"})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminNotFoundError):
        await client.get_json("/api/internal/user/plans")

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_non_actionable_prompt_error_for_snooze_400_detail_payload() -> (
    None
):
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={"detail": "webAccount link prompt is not actionable"},
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminNonActionablePromptError):
        await client.patch_json(
            "/api/internal/user/session/web-account-link-prompt-snooze",
            params={"userId": "11111111-1111-1111-1111-111111111111"},
        )

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_non_actionable_prompt_error_for_missing_web_account_400() -> (
    None
):
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": "webAccount must exist",
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminNonActionablePromptError):
        await client.patch_json(
            "/api/internal/user/session/web-account-link-prompt-snooze",
            params={"userId": "11111111-1111-1111-1111-111111111111"},
        )

    await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "webAccount password handoff is not actionable",
        "webAccount must exist",
        "webAccount link prompt is not actionable",
    ],
)
async def test_internal_admin_client_raises_non_actionable_prompt_error_for_password_handoff_400_payload(
    message: str,
) -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": message,
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminNonActionablePromptError):
        await client.patch_web_account_password(
            user_id="11111111-1111-1111-1111-111111111111",
            login="user-login",
            password="new-password-123",
        )

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_actionable_error_for_password_handoff_login_conflict() -> (
    None
):
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": "webAccount login is already taken",
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminActionablePasswordHandoffError) as actual_error:
        await client.patch_web_account_password(
            user_id="11111111-1111-1111-1111-111111111111",
            login="user-login",
            password="new-password-123",
        )

    await client.close()

    assert actual_error.value.detail == "webAccount login is already taken"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "webAccount must exist",
        "webAccount email is already verified",
        "webAccount email must exist",
    ],
)
async def test_internal_admin_client_raises_non_actionable_prompt_error_for_email_verification_challenge_400_payload(
    message: str,
) -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": message,
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminNonActionablePromptError):
        await client.patch_web_account_email_verification_challenge(
            user_id="11111111-1111-1111-1111-111111111111"
        )

    await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "webAccount must exist",
        "webAccount email is already verified",
        "webAccount email must exist",
    ],
)
async def test_internal_admin_client_raises_non_actionable_prompt_error_for_email_verification_completion_400_payload(
    message: str,
) -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": message,
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminNonActionablePromptError):
        await client.patch_web_account_email_verification_completion(
            user_id="11111111-1111-1111-1111-111111111111",
            code="123456",
        )

    await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "active email verification challenge not found",
        "invalid email verification code",
    ],
)
async def test_internal_admin_client_raises_actionable_completion_error_for_email_verification_completion_400_payload(
    message: str,
) -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": message,
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminActionableEmailVerificationCompletionError) as actual_error:
        await client.patch_web_account_email_verification_completion(
            user_id="11111111-1111-1111-1111-111111111111",
            code="123456",
        )

    assert actual_error.value.detail == message
    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_timeout_error_for_timeout() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminTimeoutError):
        await client.get_json("/api/internal/user/plans")

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_upstream_error_for_server_error() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=503, json={"detail": "unavailable"})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminUpstreamError):
        await client.get_json("/api/internal/user/plans")

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_raises_upstream_error_for_transport_failure() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminUpstreamError):
        await client.get_json("/api/internal/user/plans")

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_keeps_unexpected_snooze_400_as_upstream_error() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=400,
            json={
                "statusCode": 400,
                "message": "bad request",
                "error": "Bad Request",
            },
        )

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminUpstreamError):
        await client.patch_json(
            "/api/internal/user/session/web-account-link-prompt-snooze",
            params={"userId": "11111111-1111-1111-1111-111111111111"},
        )

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_keeps_non_snooze_400_as_upstream_error() -> None:
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=400, json={"detail": "bad request"})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminUpstreamError):
        await client.patch_json(
            "/api/internal/user/session/rules-acceptance",
            params={"userId": "11111111-1111-1111-1111-111111111111"},
        )

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_keeps_unexpected_password_handoff_400_as_upstream_error() -> (
    None
):
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=400, json={"detail": "bad request"})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminUpstreamError):
        await client.patch_web_account_password(
            user_id="11111111-1111-1111-1111-111111111111",
            login="user-login",
            password="new-password-123",
        )

    await client.close()


@pytest.mark.asyncio
async def test_internal_admin_client_keeps_unexpected_email_verification_challenge_400_as_upstream_error() -> (
    None
):
    async def handle_request(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code=400, json={"detail": "bad request"})

    transport = httpx.MockTransport(handle_request)
    client = build_internal_admin_client(
        base_url="http://rezeis-admin-api:3000",
        internal_api_key="secret-key",
        transport=transport,
    )

    with pytest.raises(InternalAdminUpstreamError):
        await client.patch_web_account_email_verification_challenge(
            user_id="11111111-1111-1111-1111-111111111111"
        )

    await client.close()


@pytest.mark.asyncio
async def test_plans_service_raises_contract_error_for_schema_drift() -> None:
    class StubInternalAdminClient:
        async def get_json(self, path: str) -> object:
            return [{"id": "plan-1", "name": "Starter"}]

    service = PlansService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.get_plans()


@pytest.mark.asyncio
async def test_platform_policy_service_raises_contract_error_for_schema_drift() -> None:
    class StubInternalAdminClient:
        async def get_json(self, path: str) -> object:
            assert path == "/api/internal/settings/platform-policy"
            return {
                "rulesRequired": True,
                "rulesLink": None,
                "channelRequired": False,
                "channelLink": None,
                "inviteModeStartedAt": None,
                "defaultCurrency": "USD",
            }

    service = PlatformPolicyService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.get_platform_policy()


@pytest.mark.asyncio
async def test_session_service_raises_contract_error_for_rules_acceptance_schema_drift() -> None:
    class StubInternalAdminClient:
        async def patch_json(self, path: str, params: dict[str, str]) -> object:
            assert path == "/api/internal/user/session/rules-acceptance"
            assert params == {"userId": "11111111-1111-1111-1111-111111111111"}
            return {"id": "user-1", "role": "USER"}

    service = SessionService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.accept_rules_by_user_id("11111111-1111-1111-1111-111111111111")


@pytest.mark.asyncio
async def test_session_service_normalizes_rules_acceptance_user_id_before_forwarding() -> None:
    expected_user_id = "11111111-1111-1111-1111-111111111111"

    class StubInternalAdminClient:
        async def patch_json(self, path: str, params: dict[str, str]) -> object:
            assert path == "/api/internal/user/session/rules-acceptance"
            assert params == {"userId": expected_user_id}
            return {
                "id": expected_user_id,
                "telegramId": "777000",
                "username": "tester",
                "name": "User",
                "email": "user@example.com",
                "role": "USER",
                "language": "EN",
                "personalDiscount": 0,
                "purchaseDiscount": 0,
                "points": 0,
                "maxSubscriptions": 1,
                "isBlocked": False,
                "isBotBlocked": False,
                "isRulesAccepted": True,
                "createdAt": "2026-04-17T00:00:00Z",
                "updatedAt": "2026-04-17T00:00:00Z",
                "webAccount": None,
            }

    service = SessionService(StubInternalAdminClient())

    actual_session = await service.accept_rules_by_user_id(
        "11111111-1111-1111-1111-111111111111".upper()
    )

    assert actual_session.id == expected_user_id


@pytest.mark.asyncio
async def test_session_service_raises_contract_error_for_web_account_link_prompt_snooze_schema_drift() -> (
    None
):
    class StubInternalAdminClient:
        async def patch_json(self, path: str, params: dict[str, str]) -> object:
            assert path == "/api/internal/user/session/web-account-link-prompt-snooze"
            assert params == {"userId": "11111111-1111-1111-1111-111111111111"}
            return {"id": "user-1", "role": "USER"}

    service = SessionService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.snooze_web_account_link_prompt_by_user_id(
            "11111111-1111-1111-1111-111111111111"
        )


@pytest.mark.asyncio
async def test_session_service_normalizes_web_account_link_prompt_snooze_user_id_before_forwarding() -> (
    None
):
    expected_user_id = "11111111-1111-1111-1111-111111111111"

    class StubInternalAdminClient:
        async def patch_json(self, path: str, params: dict[str, str]) -> object:
            assert path == "/api/internal/user/session/web-account-link-prompt-snooze"
            assert params == {"userId": expected_user_id}
            return {
                "id": expected_user_id,
                "telegramId": "777000",
                "username": "tester",
                "name": "User",
                "email": "user@example.com",
                "role": "USER",
                "language": "EN",
                "personalDiscount": 0,
                "purchaseDiscount": 0,
                "points": 0,
                "maxSubscriptions": 1,
                "isBlocked": False,
                "isBotBlocked": False,
                "isRulesAccepted": True,
                "createdAt": "2026-04-17T00:00:00Z",
                "updatedAt": "2026-04-17T00:00:00Z",
                "webAccount": None,
            }

    service = SessionService(StubInternalAdminClient())

    actual_session = await service.snooze_web_account_link_prompt_by_user_id(
        "11111111-1111-1111-1111-111111111111".upper()
    )

    assert actual_session.id == expected_user_id


@pytest.mark.asyncio
async def test_session_service_raises_contract_error_for_web_account_password_schema_drift() -> (
    None
):
    class StubInternalAdminClient:
        async def patch_web_account_password(
            self, *, user_id: str, login: str, password: str
        ) -> object:
            assert user_id == "11111111-1111-1111-1111-111111111111"
            assert login == "user-login"
            assert password == "new-password-123"
            return {"id": "user-1", "role": "USER"}

    service = SessionService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.handoff_web_account_password_by_user_id(
            "11111111-1111-1111-1111-111111111111",
            input=SessionWebAccountPasswordSchema(login="user-login", password="new-password-123"),
        )


@pytest.mark.asyncio
async def test_session_service_normalizes_web_account_password_user_id_before_forwarding() -> None:
    expected_user_id = "11111111-1111-1111-1111-111111111111"

    class StubInternalAdminClient:
        async def patch_web_account_password(
            self, *, user_id: str, login: str, password: str
        ) -> object:
            assert user_id == expected_user_id
            assert login == "user-login"
            assert password == "new-password-123"
            return {
                "id": expected_user_id,
                "telegramId": "777000",
                "username": "tester",
                "name": "User",
                "email": "user@example.com",
                "role": "USER",
                "language": "EN",
                "personalDiscount": 0,
                "purchaseDiscount": 0,
                "points": 0,
                "maxSubscriptions": 1,
                "isBlocked": False,
                "isBotBlocked": False,
                "isRulesAccepted": True,
                "createdAt": "2026-04-17T00:00:00Z",
                "updatedAt": "2026-04-17T00:00:00Z",
                "webAccount": None,
            }

    service = SessionService(StubInternalAdminClient())

    actual_session = await service.handoff_web_account_password_by_user_id(
        "11111111-1111-1111-1111-111111111111".upper(),
        input=SessionWebAccountPasswordSchema(login="user-login", password="new-password-123"),
    )

    assert actual_session.id == expected_user_id


@pytest.mark.asyncio
async def test_session_service_raises_contract_error_for_email_verification_completion_schema_drift() -> (
    None
):
    class StubInternalAdminClient:
        async def patch_web_account_email_verification_completion(
            self,
            *,
            user_id: str,
            code: str,
        ) -> object:
            assert user_id == "11111111-1111-1111-1111-111111111111"
            assert code == "123456"
            return {"id": "user-1", "role": "USER"}

    service = SessionService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.complete_web_account_email_verification_by_user_id(
            "11111111-1111-1111-1111-111111111111",
            input=SessionWebAccountEmailVerificationCompletionSchema(code="123456"),
        )


@pytest.mark.asyncio
async def test_session_service_normalizes_email_verification_completion_user_id_before_forwarding() -> (
    None
):
    expected_user_id = "11111111-1111-1111-1111-111111111111"

    class StubInternalAdminClient:
        async def patch_web_account_email_verification_completion(
            self,
            *,
            user_id: str,
            code: str,
        ) -> object:
            assert user_id == expected_user_id
            assert code == "123456"
            return {
                "id": expected_user_id,
                "telegramId": "777000",
                "username": "tester",
                "name": "User",
                "email": "user@example.com",
                "role": "USER",
                "language": "EN",
                "personalDiscount": 0,
                "purchaseDiscount": 0,
                "points": 0,
                "maxSubscriptions": 1,
                "isBlocked": False,
                "isBotBlocked": False,
                "isRulesAccepted": True,
                "createdAt": "2026-04-17T00:00:00Z",
                "updatedAt": "2026-04-17T00:00:00Z",
                "webAccount": None,
            }

    service = SessionService(StubInternalAdminClient())

    actual_session = await service.complete_web_account_email_verification_by_user_id(
        "11111111-1111-1111-1111-111111111111".upper(),
        input=SessionWebAccountEmailVerificationCompletionSchema(code="123456"),
    )

    assert actual_session.id == expected_user_id


@pytest.mark.asyncio
async def test_session_service_raises_contract_error_for_email_verification_challenge_schema_drift() -> (
    None
):
    class StubInternalAdminClient:
        async def patch_web_account_email_verification_challenge(self, *, user_id: str) -> object:
            assert user_id == "11111111-1111-1111-1111-111111111111"
            return {"webAccountId": "account-1"}

    service = SessionService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.issue_web_account_email_verification_challenge_by_user_id(
            "11111111-1111-1111-1111-111111111111"
        )


@pytest.mark.asyncio
async def test_session_service_raises_contract_error_for_email_verification_challenge_missing_expiry() -> (
    None
):
    class StubInternalAdminClient:
        async def patch_web_account_email_verification_challenge(self, *, user_id: str) -> object:
            assert user_id == "11111111-1111-1111-1111-111111111111"
            return {
                "webAccountId": "22222222-2222-2222-2222-222222222222",
                "email": "user@example.com",
            }

    service = SessionService(StubInternalAdminClient())

    with pytest.raises(InternalAdminContractError):
        await service.issue_web_account_email_verification_challenge_by_user_id(
            "11111111-1111-1111-1111-111111111111"
        )


@pytest.mark.asyncio
async def test_session_service_normalizes_email_verification_challenge_user_id_before_forwarding_and_adds_public_edge_null_verified_state() -> (
    None
):
    expected_user_id = "11111111-1111-1111-1111-111111111111"

    class StubInternalAdminClient:
        async def patch_web_account_email_verification_challenge(self, *, user_id: str) -> object:
            assert user_id == expected_user_id
            return {
                "webAccountId": "22222222-2222-2222-2222-222222222222",
                "email": "user@example.com",
                "challengeExpiresAt": "2026-04-17T05:15:00Z",
            }

    service = SessionService(StubInternalAdminClient())

    actual_challenge = await service.issue_web_account_email_verification_challenge_by_user_id(
        "11111111-1111-1111-1111-111111111111".upper()
    )

    assert actual_challenge.web_account_id == "22222222-2222-2222-2222-222222222222"
    assert actual_challenge.email_verified_at is None
