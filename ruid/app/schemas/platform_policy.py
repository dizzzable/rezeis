from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.plans import CurrencyValue

AccessModeValue = Literal[
    "PUBLIC",
    "INVITED",
    "PURCHASE_BLOCKED",
    "REG_BLOCKED",
    "RESTRICTED",
]


class PlatformPolicySchema(BaseModel):
    rulesRequired: bool
    rulesLink: str | None
    channelRequired: bool
    channelLink: str | None
    accessMode: AccessModeValue
    inviteModeStartedAt: datetime | None
    defaultCurrency: CurrencyValue
