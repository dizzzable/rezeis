from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

LOGIN_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


class SessionWebAccountPasswordSchema(BaseModel):
    login: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=128)

    @field_validator("login")
    @classmethod
    def validate_login(cls, value: str) -> str:
        sanitized_value = value.strip()
        if not LOGIN_PATTERN.fullmatch(sanitized_value):
            raise ValueError(
                "login must contain only letters, numbers, dots, underscores, or hyphens"
            )
        return sanitized_value
