from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PlanTypeValue = Literal["TRAFFIC", "DEVICES", "BOTH", "UNLIMITED"]
SubscriptionStatusValue = Literal["ACTIVE", "DISABLED", "LIMITED", "EXPIRED", "DELETED"]


class SubscriptionPlanSchema(BaseModel):
    name: str | None
    type: PlanTypeValue | None


class SubscriptionSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    status: SubscriptionStatusValue
    is_trial: bool = Field(alias="isTrial")
    plan: SubscriptionPlanSchema | None
    traffic_limit: int | None = Field(alias="trafficLimit")
    device_limit: int = Field(alias="deviceLimit")
    config_url: str | None = Field(alias="configUrl")
    started_at: datetime | None = Field(alias="startedAt")
    expires_at: datetime | None = Field(alias="expiresAt")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
