from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class TelegramUserSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    username: str | None = None
    first_name: str | None = Field(default=None, alias="first_name")
    last_name: str | None = Field(default=None, alias="last_name")
    language_code: str | None = Field(default=None, alias="language_code")


class TelegramInitDataSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    raw_init_data: str = Field(alias="rawInitData")
    telegram_id: str = Field(alias="telegramId")
    auth_date: datetime = Field(alias="authDate")
    user: TelegramUserSchema
