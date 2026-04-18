from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class InternalWebAccountEmailVerificationChallengeSchema(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    web_account_id: str = Field(alias="webAccountId")
    email: str
    challenge_expires_at: datetime = Field(alias="challengeExpiresAt")
