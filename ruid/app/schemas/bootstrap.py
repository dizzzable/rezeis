from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.session import SessionSchema
from app.schemas.subscription import SubscriptionSchema


class TelegramBootstrapResponseSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session: SessionSchema
    subscription: SubscriptionSchema | None
    expires_in: int = Field(alias="expiresIn")
