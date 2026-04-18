from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

LocaleValue = Literal["EN", "RU"]
UserRoleValue = Literal["DEV", "ADMIN", "USER"]


class SessionWebAccountSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    login: str | None
    login_normalized: str | None = Field(alias="loginNormalized")
    email: str | None
    email_normalized: str | None = Field(alias="emailNormalized")
    email_verified_at: datetime | None = Field(alias="emailVerifiedAt")
    requires_password_change: bool = Field(alias="requiresPasswordChange")
    link_prompt_snooze_until: datetime | None = Field(alias="linkPromptSnoozeUntil")
    credentials_bootstrapped_at: datetime | None = Field(alias="credentialsBootstrappedAt")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")


class SessionSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    telegram_id: str | None = Field(alias="telegramId")
    username: str | None
    name: str | None
    email: str | None
    role: UserRoleValue
    language: LocaleValue
    personal_discount: int = Field(alias="personalDiscount")
    purchase_discount: int = Field(alias="purchaseDiscount")
    points: int
    max_subscriptions: int = Field(alias="maxSubscriptions")
    is_blocked: bool = Field(alias="isBlocked")
    is_bot_blocked: bool = Field(alias="isBotBlocked")
    is_rules_accepted: bool = Field(alias="isRulesAccepted")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")
    web_account: SessionWebAccountSchema | None = Field(alias="webAccount")
