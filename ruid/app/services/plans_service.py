from __future__ import annotations

from pydantic import ValidationError
from pydantic import TypeAdapter

from app.schemas.plans import PlanSchema
from app.services.internal_admin_client import InternalAdminClient, InternalAdminContractError

PLANS_SCHEMA_ADAPTER = TypeAdapter(list[PlanSchema])


class PlansService:
    def __init__(self, client: InternalAdminClient) -> None:
        self._client = client

    async def get_plans(self) -> list[PlanSchema]:
        payload = await self._client.get_json("/api/internal/user/plans")
        try:
            return PLANS_SCHEMA_ADAPTER.validate_python(payload)
        except ValidationError as err:
            raise InternalAdminContractError from err
