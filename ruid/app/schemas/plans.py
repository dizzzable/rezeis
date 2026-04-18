from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CurrencyValue = Literal["USD", "RUB", "USDT", "TON", "BTC", "ETH"]
PlanTypeValue = Literal["TRAFFIC", "DEVICES", "BOTH", "UNLIMITED"]


class PlanPriceSchema(BaseModel):
    currency: CurrencyValue
    price: str


class PlanDurationSchema(BaseModel):
    id: str
    days: int
    prices: list[PlanPriceSchema]


class PlanSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    order_index: int = Field(alias="orderIndex")
    name: str
    description: str | None
    tag: str | None
    type: PlanTypeValue
    traffic_limit: int | None = Field(alias="trafficLimit")
    device_limit: int = Field(alias="deviceLimit")
    durations: list[PlanDurationSchema]
