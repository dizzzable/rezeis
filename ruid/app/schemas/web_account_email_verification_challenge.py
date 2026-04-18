from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class WebAccountEmailVerificationChallengeSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    web_account_id: str | None = Field(alias="webAccountId")
    email: str | None
    challenge_expires_at: datetime | None = Field(alias="challengeExpiresAt")
    email_verified_at: datetime | None = Field(alias="emailVerifiedAt")
