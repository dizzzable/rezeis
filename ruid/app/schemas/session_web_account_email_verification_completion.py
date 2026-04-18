from __future__ import annotations

from pydantic import BaseModel, Field


class SessionWebAccountEmailVerificationCompletionSchema(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
