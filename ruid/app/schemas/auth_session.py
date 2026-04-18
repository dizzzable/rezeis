from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AuthSessionSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    user_id: str = Field(alias="userId")
    telegram_id: str = Field(alias="telegramId")
    created_at: datetime = Field(alias="createdAt")
