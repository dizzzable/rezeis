from __future__ import annotations

import pytest

from app.services.session_store import RedisSessionStore
from tests.support import StubRedisClient


@pytest.mark.asyncio
async def test_session_store_treats_corrupt_payload_as_missing_session() -> None:
    session_key = "ruid:session:broken-session"
    redis_client = StubRedisClient({session_key: '{"broken":true}'})
    session_store = RedisSessionStore(
        redis_client=redis_client,
        key_prefix="ruid:session",
        ttl_seconds=300,
        bootstrap_proof_key_suffix="bootstrap-proof",
    )

    actual_session = await session_store.get_session("broken-session")

    assert actual_session is None
    assert redis_client.deleted_keys == [session_key]
    assert redis_client.expired_keys == []
