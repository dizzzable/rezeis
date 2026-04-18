from __future__ import annotations

from pydantic import ValidationError

from app.schemas.subscription import SubscriptionSchema
from app.schemas.user_lookup import UserLookupSchema
from app.services.internal_admin_client import InternalAdminClient, InternalAdminContractError


class SubscriptionService:
    def __init__(self, client: InternalAdminClient) -> None:
        self._client = client

    async def get_subscription(self, lookup: UserLookupSchema) -> SubscriptionSchema | None:
        payload = await self._client.get_json(
            "/api/internal/user/subscription",
            params=lookup.to_query_params(),
        )
        if payload is None:
            return None
        try:
            return SubscriptionSchema.model_validate(payload)
        except ValidationError as err:
            raise InternalAdminContractError from err

    async def get_subscription_by_user_id(self, user_id: str) -> SubscriptionSchema | None:
        lookup = UserLookupSchema.model_validate({"userId": user_id})
        return await self.get_subscription(lookup)
