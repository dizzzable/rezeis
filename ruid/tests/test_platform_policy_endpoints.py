from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.dependencies import get_platform_policy_service
from app.main import app
from app.schemas.platform_policy import PlatformPolicySchema
from app.services.internal_admin_client import (
    InternalAdminContractError,
    InternalAdminNotFoundError,
)


def test_get_platform_policy_endpoint_returns_typed_payload() -> None:
    expected_policy = PlatformPolicySchema.model_validate(
        {
            "rulesRequired": True,
            "rulesLink": "https://example.com/rules",
            "channelRequired": False,
            "channelLink": "https://t.me/example",
            "accessMode": "INVITED",
            "inviteModeStartedAt": "2026-04-10T09:30:00.000Z",
            "defaultCurrency": "USD",
        },
    )

    class StubPlatformPolicyService:
        async def get_platform_policy(self) -> PlatformPolicySchema:
            return expected_policy

    app.dependency_overrides[get_platform_policy_service] = lambda: StubPlatformPolicyService()

    with TestClient(app) as client:
        response = client.get("/api/v1/platform-policy")

    assert response.status_code == 200
    assert response.json() == {
        "rulesRequired": True,
        "rulesLink": "https://example.com/rules",
        "channelRequired": False,
        "channelLink": "https://t.me/example",
        "accessMode": "INVITED",
        "inviteModeStartedAt": "2026-04-10T09:30:00Z",
        "defaultCurrency": "USD",
    }


def test_get_platform_policy_endpoint_maps_contract_drift_to_bad_gateway() -> None:
    class StubPlatformPolicyService:
        async def get_platform_policy(self) -> PlatformPolicySchema:
            raise InternalAdminContractError()

    app.dependency_overrides[get_platform_policy_service] = lambda: StubPlatformPolicyService()

    with TestClient(app) as client:
        response = client.get("/api/v1/platform-policy")

    assert response.status_code == 502
    assert response.json() == {"detail": "Internal admin returned an invalid contract payload"}


def test_get_platform_policy_endpoint_maps_upstream_not_found_to_bad_gateway() -> None:
    class StubPlatformPolicyService:
        async def get_platform_policy(self) -> PlatformPolicySchema:
            raise InternalAdminNotFoundError()

    app.dependency_overrides[get_platform_policy_service] = lambda: StubPlatformPolicyService()

    with TestClient(app) as client:
        response = client.get("/api/v1/platform-policy")

    assert response.status_code == 502
    assert response.json() == {"detail": "Internal admin request failed"}
