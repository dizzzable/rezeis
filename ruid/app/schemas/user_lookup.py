from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EMAIL_LOOKUP_MAX_LENGTH = 320
EMAIL_LOOKUP_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class UserLookupSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    user_id: UUID | None = Field(default=None, alias="userId")
    telegram_id: str | None = Field(default=None, alias="telegramId")
    email: str | None = Field(default=None)

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        stripped_value = value.strip()
        return stripped_value if stripped_value else None

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if len(value) > EMAIL_LOOKUP_MAX_LENGTH:
            raise ValueError("email must be at most 320 characters long.")
        if EMAIL_LOOKUP_PATTERN.fullmatch(value) is None:
            raise ValueError("email must be a valid email address.")
        return value

    @model_validator(mode="after")
    def validate_identifiers(self) -> "UserLookupSchema":
        defined_identifiers = [
            identifier
            for identifier in (self.user_id, self.telegram_id, self.email)
            if identifier is not None
        ]
        if len(defined_identifiers) != 1:
            raise ValueError("Exactly one of userId, telegramId, or email is required.")
        if self.telegram_id is not None and not self.telegram_id.isdigit():
            raise ValueError("telegramId must be a valid integer string.")
        return self

    def to_query_params(self) -> dict[str, str]:
        query_params: dict[str, str] = {}
        if self.user_id is not None:
            query_params["userId"] = str(self.user_id)
        if self.telegram_id is not None:
            query_params["telegramId"] = self.telegram_id
        if self.email is not None:
            query_params["email"] = self.email
        return query_params

    @classmethod
    def from_query(
        cls,
        *,
        user_id: str | None,
        telegram_id: str | None,
        email: str | None,
    ) -> "UserLookupSchema":
        payload: dict[str, Any] = {
            "userId": user_id,
            "telegramId": telegram_id,
            "email": email,
        }
        return cls.model_validate(payload)
