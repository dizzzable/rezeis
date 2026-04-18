from __future__ import annotations

import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

from app.core.config import get_settings
from app.schemas.auth_session import AuthSessionSchema
from app.schemas.session import SessionSchema
from app.schemas.subscription import SubscriptionSchema


def build_telegram_init_data(
    *,
    bot_token: str,
    telegram_id: int,
    auth_date: datetime,
) -> str:
    user_payload = json.dumps(
        {
            "id": telegram_id,
            "first_name": "Test",
            "username": "tester",
            "language_code": "en",
        },
        separators=(",", ":"),
    )
    unsigned_payload = {
        "auth_date": str(int(auth_date.timestamp())),
        "query_id": "query-id",
        "user": user_payload,
    }
    data_check_string = "\n".join(
        f"{key}={value}" for key, value in sorted(unsigned_payload.items())
    )
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    signature = hmac.new(
        secret_key,
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return urlencode({**unsigned_payload, "hash": signature})


class InMemorySessionStore:
    def __init__(self) -> None:
        self.created_session_id: str | None = None
        self.sessions: dict[str, AuthSessionSchema] = {}
        self.used_bootstrap_proofs: set[str] = set()
        self.deleted_session_ids: list[str] = []

    async def create_session(self, session: AuthSessionSchema) -> str:
        session_id = "stored-session-id"
        self.sessions[session_id] = session
        self.created_session_id = session_id
        return session_id

    async def get_session(self, session_id: str) -> AuthSessionSchema | None:
        return self.sessions.get(session_id)

    async def delete_session(self, session_id: str) -> None:
        self.deleted_session_ids.append(session_id)
        self.sessions.pop(session_id, None)

    async def reserve_bootstrap_proof(self, raw_init_data: str, ttl_seconds: int) -> bool:
        if raw_init_data in self.used_bootstrap_proofs:
            return False
        self.used_bootstrap_proofs.add(raw_init_data)
        return True


class StubRedisClient:
    def __init__(self, values: dict[str, str]) -> None:
        self.values = values
        self.deleted_keys: list[str] = []
        self.expired_keys: list[tuple[str, int]] = []

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def delete(self, key: str) -> None:
        self.deleted_keys.append(key)
        self.values.pop(key, None)

    async def expire(self, key: str, ttl_seconds: int) -> None:
        self.expired_keys.append((key, ttl_seconds))


def build_expected_session() -> SessionSchema:
    return SessionSchema.model_validate(
        {
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "telegramId": "777000",
            "username": "tester",
            "name": "User",
            "email": "user@example.com",
            "role": "USER",
            "language": "EN",
            "personalDiscount": 0,
            "purchaseDiscount": 0,
            "points": 0,
            "maxSubscriptions": 1,
            "isBlocked": False,
            "isBotBlocked": False,
            "isRulesAccepted": True,
            "createdAt": datetime.now(UTC).isoformat(),
            "updatedAt": datetime.now(UTC).isoformat(),
            "webAccount": None,
        },
    )


def build_expected_subscription() -> SubscriptionSchema:
    return SubscriptionSchema.model_validate(
        {
            "id": "subscription-1",
            "status": "ACTIVE",
            "isTrial": False,
            "plan": {"name": "Starter", "type": "BOTH"},
            "trafficLimit": 100,
            "deviceLimit": 3,
            "configUrl": "https://example.com/config",
            "startedAt": datetime.now(UTC).isoformat(),
            "expiresAt": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
            "createdAt": datetime.now(UTC).isoformat(),
            "updatedAt": datetime.now(UTC).isoformat(),
        },
    )


def build_auth_session(*, user_id: str, telegram_id: str = "777000") -> AuthSessionSchema:
    return AuthSessionSchema.model_validate(
        {
            "userId": user_id,
            "telegramId": telegram_id,
            "createdAt": datetime.now(UTC),
        },
    )


def reset_settings_cache() -> None:
    get_settings.cache_clear()
