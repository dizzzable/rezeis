from __future__ import annotations

from pydantic import ValidationError

from app.schemas.platform_policy import PlatformPolicySchema
from app.services.internal_admin_client import InternalAdminClient, InternalAdminContractError


class PlatformPolicyService:
    def __init__(self, client: InternalAdminClient) -> None:
        self._client = client

    async def get_platform_policy(self) -> PlatformPolicySchema:
        payload = await self._client.get_json("/api/internal/settings/platform-policy")
        try:
            return PlatformPolicySchema.model_validate(payload)
        except ValidationError as err:
            raise InternalAdminContractError from err
