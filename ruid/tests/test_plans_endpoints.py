from __future__ import annotations

from fastapi.testclient import TestClient

from app.api.dependencies import get_plans_service
from app.main import app
from app.schemas.plans import PlanSchema
from app.services.internal_admin_client import InternalAdminContractError


def test_get_plans_endpoint_returns_typed_payload() -> None:
    expected_plan = PlanSchema.model_validate(
        {
            "id": "plan-1",
            "orderIndex": 1,
            "name": "Starter",
            "description": "Starter plan",
            "tag": "popular",
            "type": "BOTH",
            "trafficLimit": 100,
            "deviceLimit": 3,
            "durations": [
                {
                    "id": "duration-1",
                    "days": 30,
                    "prices": [{"currency": "USD", "price": "9.99"}],
                }
            ],
        },
    )

    class StubPlansService:
        async def get_plans(self) -> list[PlanSchema]:
            return [expected_plan]

    app.dependency_overrides[get_plans_service] = lambda: StubPlansService()

    with TestClient(app) as client:
        response = client.get("/api/v1/plans")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": "plan-1",
            "orderIndex": 1,
            "name": "Starter",
            "description": "Starter plan",
            "tag": "popular",
            "type": "BOTH",
            "trafficLimit": 100,
            "deviceLimit": 3,
            "durations": [
                {
                    "id": "duration-1",
                    "days": 30,
                    "prices": [{"currency": "USD", "price": "9.99"}],
                }
            ],
        }
    ]


def test_get_plans_endpoint_maps_contract_drift_to_bad_gateway() -> None:
    class StubPlansService:
        async def get_plans(self) -> list[PlanSchema]:
            raise InternalAdminContractError()

    app.dependency_overrides[get_plans_service] = lambda: StubPlansService()

    with TestClient(app) as client:
        response = client.get("/api/v1/plans")

    assert response.status_code == 502
    assert response.json() == {"detail": "Internal admin returned an invalid contract payload"}
