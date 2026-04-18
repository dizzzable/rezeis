from __future__ import annotations

from pydantic import ValidationError

from app.schemas.internal_web_account_email_verification_challenge import (
    InternalWebAccountEmailVerificationChallengeSchema,
)
from app.schemas.session import SessionSchema
from app.schemas.session_web_account_email_verification_completion import (
    SessionWebAccountEmailVerificationCompletionSchema,
)
from app.schemas.session_web_account_password import SessionWebAccountPasswordSchema
from app.schemas.user_lookup import UserLookupSchema
from app.schemas.web_account_email_verification_challenge import (
    WebAccountEmailVerificationChallengeSchema,
)
from app.services.internal_admin_client import InternalAdminClient, InternalAdminContractError


class SessionService:
    def __init__(self, client: InternalAdminClient) -> None:
        self._client = client

    async def get_session(self, lookup: UserLookupSchema) -> SessionSchema:
        payload = await self._client.get_json(
            "/api/internal/user/session",
            params=lookup.to_query_params(),
        )
        return self._validate_session(payload)

    async def get_session_by_telegram_id(self, telegram_id: str) -> SessionSchema:
        lookup = UserLookupSchema.model_validate({"telegramId": telegram_id})
        return await self.get_session(lookup)

    async def get_session_by_user_id(self, user_id: str) -> SessionSchema:
        lookup = self._build_user_id_lookup(user_id)
        return await self.get_session(lookup)

    async def accept_rules_by_user_id(self, user_id: str) -> SessionSchema:
        lookup = self._build_user_id_lookup(user_id)
        payload = await self._client.patch_json(
            "/api/internal/user/session/rules-acceptance",
            params=lookup.to_query_params(),
        )
        return self._validate_session(payload)

    async def snooze_web_account_link_prompt_by_user_id(self, user_id: str) -> SessionSchema:
        lookup = self._build_user_id_lookup(user_id)
        payload = await self._client.patch_json(
            "/api/internal/user/session/web-account-link-prompt-snooze",
            params=lookup.to_query_params(),
        )
        return self._validate_session(payload)

    async def handoff_web_account_password_by_user_id(
        self,
        user_id: str,
        input: SessionWebAccountPasswordSchema,
    ) -> SessionSchema:
        lookup = self._build_user_id_lookup(user_id)
        payload = await self._client.patch_web_account_password(
            user_id=str(lookup.user_id),
            login=input.login,
            password=input.password,
        )
        return self._validate_session(payload)

    async def issue_web_account_email_verification_challenge_by_user_id(
        self,
        user_id: str,
    ) -> WebAccountEmailVerificationChallengeSchema:
        lookup = self._build_user_id_lookup(user_id)
        payload = await self._client.patch_web_account_email_verification_challenge(
            user_id=str(lookup.user_id)
        )
        return self._validate_web_account_email_verification_challenge(payload)

    async def complete_web_account_email_verification_by_user_id(
        self,
        user_id: str,
        input: SessionWebAccountEmailVerificationCompletionSchema,
    ) -> SessionSchema:
        lookup = self._build_user_id_lookup(user_id)
        payload = await self._client.patch_web_account_email_verification_completion(
            user_id=str(lookup.user_id),
            code=input.code,
        )
        return self._validate_session(payload)

    def _validate_session(self, payload: object) -> SessionSchema:
        try:
            return SessionSchema.model_validate(payload)
        except ValidationError as err:
            raise InternalAdminContractError from err

    def _validate_web_account_email_verification_challenge(
        self,
        payload: object,
    ) -> WebAccountEmailVerificationChallengeSchema:
        try:
            internal_payload = InternalWebAccountEmailVerificationChallengeSchema.model_validate(
                payload
            )
        except ValidationError as err:
            raise InternalAdminContractError from err
        return WebAccountEmailVerificationChallengeSchema(
            webAccountId=internal_payload.web_account_id,
            email=internal_payload.email,
            challengeExpiresAt=internal_payload.challenge_expires_at,
            emailVerifiedAt=None,
        )

    def _build_user_id_lookup(self, user_id: str) -> UserLookupSchema:
        return UserLookupSchema.model_validate({"userId": user_id})
