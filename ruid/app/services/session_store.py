from __future__ import annotations

import hashlib
import secrets

from pydantic import ValidationError
from redis.asyncio import Redis

from app.schemas.auth_session import AuthSessionSchema


class RedisSessionStore:
    def __init__(
        self,
        *,
        redis_client: Redis,
        key_prefix: str,
        ttl_seconds: int,
        bootstrap_proof_key_suffix: str,
    ) -> None:
        self._redis_client = redis_client
        self._key_prefix = key_prefix
        self._ttl_seconds = ttl_seconds
        self._bootstrap_proof_key_suffix = bootstrap_proof_key_suffix

    async def create_session(self, session: AuthSessionSchema) -> str:
        session_id = secrets.token_urlsafe(32)
        await self._redis_client.set(
            self._build_key(session_id),
            session.model_dump_json(by_alias=True),
            ex=self._ttl_seconds,
        )
        return session_id

    async def get_session(self, session_id: str) -> AuthSessionSchema | None:
        session_key = self._build_key(session_id)
        serialized_session = await self._redis_client.get(session_key)
        if serialized_session is None:
            return None
        try:
            auth_session = AuthSessionSchema.model_validate_json(serialized_session)
        except ValidationError:
            await self._redis_client.delete(session_key)
            return None
        await self._redis_client.expire(session_key, self._ttl_seconds)
        return auth_session

    async def delete_session(self, session_id: str) -> None:
        await self._redis_client.delete(self._build_key(session_id))

    async def reserve_bootstrap_proof(self, raw_init_data: str, ttl_seconds: int) -> bool:
        proof_key = self._build_bootstrap_proof_key(raw_init_data)
        was_set = await self._redis_client.set(proof_key, "1", ex=ttl_seconds, nx=True)
        return bool(was_set)

    def _build_key(self, session_id: str) -> str:
        return f"{self._key_prefix}:{session_id}"

    def _build_bootstrap_proof_key(self, raw_init_data: str) -> str:
        proof_hash = hashlib.sha256(raw_init_data.encode("utf-8")).hexdigest()
        return f"{self._key_prefix}:{self._bootstrap_proof_key_suffix}:{proof_hash}"
